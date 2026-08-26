import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";
import type { protocol, Runner, RunStreamEvent } from "@openai/agents";
import {
  Agent,
  RunToolApprovalItem as ApprovalItem,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  RunToolCallOutputItem,
} from "@openai/agents";
import type {
  InterruptedState,
  ResumableRun,
  WireMessage,
} from "../src/index.ts";
import { decodeMessages, renderableEvents, startReply } from "../src/index.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

const agent = new Agent({ name: "test-agent" });

function textDelta(delta: string): RunRawModelStreamEvent {
  return new RunRawModelStreamEvent({ type: "output_text_delta", delta });
}

function approval(callId = "call_1"): ApprovalItem {
  const raw: protocol.FunctionCallItem = {
    type: "function_call",
    callId,
    name: "risky",
    arguments: '{"action": "wipe"}',
  };
  return new ApprovalItem(raw, agent);
}

/** The three members the handler and the decode use of a RunState. */
class FakeState implements InterruptedState {
  readonly approved: ApprovalItem[] = [];
  readonly rejected: ApprovalItem[] = [];
  private readonly pending: ApprovalItem[];

  constructor(pending: ApprovalItem[] = []) {
    this.pending = pending;
  }

  getInterruptions(): ApprovalItem[] {
    return this.pending;
  }

  approve(approvalItem: ApprovalItem): void {
    this.approved.push(approvalItem);
  }

  reject(approvalItem: ApprovalItem): void {
    this.rejected.push(approvalItem);
  }
}

/** The members the handler reads off a streamed run. */
class FakeRun implements ResumableRun {
  readonly interruptions: ApprovalItem[];
  readonly state: FakeState;
  private readonly events: RunStreamEvent[];
  private readonly sendAfter: (() => void) | undefined;

  constructor(
    events: RunStreamEvent[],
    options?: {
      interruptions?: ApprovalItem[];
      state?: FakeState;
      sendAfter?: () => void;
    },
  ) {
    this.events = events;
    this.interruptions = options?.interruptions ?? [];
    this.state = options?.state ?? new FakeState();
    this.sendAfter = options?.sendAfter;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
    this.sendAfter?.();
  }
}

/**
 * A run function that replays scripted runs, one per call.
 *
 * Constructed input data, not a mock: it holds the runs to hand out and
 * the inputs it was started on, and verifies nothing itself. The cast to
 * `Runner` is the tests' usual door for a deliberately shaped double.
 */
class ReplayRunner {
  readonly inputs: unknown[] = [];
  private readonly runs: ResumableRun[];

  constructor(...runs: ResumableRun[]) {
    this.runs = runs;
  }

  async run(_agent: Agent, input: unknown): Promise<ResumableRun> {
    this.inputs.push(input);
    const next = this.runs.shift();
    if (next === undefined) {
      throw new Error("no scripted run left");
    }
    return next;
  }
}

/** One tool output stream event carrying a file the named tool returned. */
function fileOutput(
  name: string,
  filename: string,
  base64: string,
): RunStreamEvent {
  return new RunItemStreamEvent(
    "tool_output",
    new RunToolCallOutputItem(
      {
        type: "function_call_result",
        callId: "call_1",
        name,
        status: "completed",
        output: [
          {
            type: "input_file",
            file: `data:image/png;base64,${base64}`,
            filename,
          },
        ],
      },
      agent,
      "",
    ),
  );
}

async function events(
  runner: ReplayRunner,
  payload: unknown,
  options?: { state?: FakeState; filesFrom?: Iterable<string> },
) {
  const run = await startReply(agent, payload, {
    runner: runner as unknown as Runner,
    ...(options?.state === undefined ? {} : { state: options.state }),
  });
  return await Array.fromAsync(
    renderableEvents(run, { filesFrom: options?.filesFrom ?? [] }),
  );
}

describe("startReply", () => {
  test("a turn streams the renderable events", async () => {
    const runner = new ReplayRunner(new FakeRun([textDelta("hi")]));

    assert.deepEqual(await events(runner, { messages: [] }), [{ data: "hi" }]);
  });

  test("a turn runs on the decoded messages", async () => {
    const runner = new ReplayRunner(new FakeRun([]));
    const messages: WireMessage[] = [
      { role: "user", content: [{ text: "hello" }] },
    ];

    await events(runner, { messages });

    assert.deepEqual(runner.inputs, [decodeMessages(messages)]);
  });

  test("a resume runs on the state it was given, answers applied", async () => {
    const item = approval("call_1");
    const state = new FakeState([item]);
    const runner = new ReplayRunner(new FakeRun([textDelta("resumed")]));

    const resumed = await events(
      runner,
      { interrupt_responses: { call_1: { value: true, source: "option" } } },
      { state },
    );

    assert.deepEqual(resumed, [{ data: "resumed" }]);
    assert.deepEqual(state.approved, [item]);
    assert.equal(runner.inputs[0], state);
  });

  test("a rejected approval is recorded as rejected", async () => {
    const item = approval("call_1");
    const state = new FakeState([item]);
    const runner = new ReplayRunner(new FakeRun([]));

    await events(
      runner,
      { interrupt_responses: { call_1: { value: false, source: "option" } } },
      { state },
    );

    assert.deepEqual(state.rejected, [item]);
  });

  test("answers without a state to resume are refused", async () => {
    const runner = new ReplayRunner();

    await assert.rejects(
      events(runner, {
        interrupt_responses: { call_1: { value: true, source: "option" } },
      }),
      /no state to resume/,
    );
  });

  test("a run that stops for approval ends with its interrupts", async () => {
    const item = approval("call_1");
    const runner = new ReplayRunner(
      new FakeRun([], { interruptions: [item], state: new FakeState([item]) }),
    );

    const streamed = await events(runner, { messages: [] });

    const [only] = streamed;
    assert.ok(only !== undefined && "interrupt" in only);
    assert.equal(only.interrupt.id, "call_1");
  });

  test("a tool's files ride the reply only when the tool is named", async () => {
    const withFile = () =>
      new ReplayRunner(
        new FakeRun([fileOutput("risky", "chart.png", PNG_BASE64)]),
      );

    const listed = await events(
      withFile(),
      { messages: [] },
      {
        filesFrom: ["risky"],
      },
    );
    const unlisted = await events(withFile(), { messages: [] });

    assert.ok(listed.some((event) => "file" in event));
    assert.ok(!unlisted.some((event) => "file" in event));
  });
});

describe("startReply without a runner of its own", () => {
  test("falls back to a default Runner", async () => {
    // The default resolves models against the OpenAI platform, which this
    // test must have no key for — reaching that failure is the point: it
    // says the fallback was taken. The environment's key, if any, is held
    // aside so the default Runner cannot reach the platform for real.
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const run = await startReply(agent, { messages: [] });

      await assert.rejects(
        Array.fromAsync(renderableEvents(run, { filesFrom: [] })),
        /OPENAI_API_KEY|api_key|apiKey/i,
      );
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });
});
