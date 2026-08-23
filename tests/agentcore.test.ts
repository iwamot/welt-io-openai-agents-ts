import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";
import type { protocol, Runner, RunStreamEvent } from "@openai/agents";
import {
  Agent,
  RunToolApprovalItem as ApprovalItem,
  RunRawModelStreamEvent,
} from "@openai/agents";
import type { ResumableRun } from "../src/agentcore.ts";
import { sendFile, weltAgent } from "../src/agentcore.ts";
import type { InterruptedState, WireMessage } from "../src/index.ts";
import { decodeMessages } from "../src/index.ts";

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

function handlerWith(runner: ReplayRunner, filesFrom?: Iterable<string>) {
  return weltAgent(agent, {
    runner: runner as unknown as Runner,
    ...(filesFrom === undefined ? {} : { filesFrom }),
  });
}

function frames(handler: ReturnType<typeof weltAgent>, payload: unknown) {
  return Array.fromAsync(handler.process(payload));
}

describe("weltAgent", () => {
  test("builds a handler without a runner of its own", () => {
    const handler = weltAgent(agent);

    assert.equal(typeof handler.process, "function");
  });

  test("a turn streams the renderable events as SSE frames", async () => {
    const handler = handlerWith(
      new ReplayRunner(new FakeRun([textDelta("hi")])),
    );

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "hi" } },
    ]);
  });

  test("a turn runs on the decoded messages", async () => {
    const runner = new ReplayRunner(new FakeRun([]));
    const messages: WireMessage[] = [
      { role: "user", content: [{ text: "hello" }] },
    ];

    await frames(handlerWith(runner), { messages });

    assert.deepEqual(runner.inputs, [decodeMessages(messages)]);
  });

  test("a file a tool queued rides beside the reply", async () => {
    const run: ResumableRun = {
      interruptions: [],
      state: new FakeState(),
      async *[Symbol.asyncIterator]() {
        yield textDelta("before");
        sendFile("chart.png", PNG_BYTES);
        yield textDelta("after");
      },
    };

    const handler = handlerWith(new ReplayRunner(run), ["some_tool"]);

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "before" } },
      { data: { data: "after" } },
      { data: { file: { name: "chart.png", bytes: PNG_BASE64 } } },
    ]);
  });

  test("a file queued after the last event still rides the reply", async () => {
    const run = new FakeRun([textDelta("before")], {
      sendAfter: () => sendFile("chart.png", PNG_BYTES),
    });

    const handler = handlerWith(new ReplayRunner(run));

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "before" } },
      { data: { file: { name: "chart.png", bytes: PNG_BASE64 } } },
    ]);
  });

  test("a failed turn's leftover files stay off the next reply", async () => {
    sendFile("stale.txt", new Uint8Array([1]));
    const handler = handlerWith(
      new ReplayRunner(new FakeRun([textDelta("fresh")])),
    );

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "fresh" } },
    ]);
  });

  test("resume without an interrupted run is refused", async () => {
    const handler = handlerWith(new ReplayRunner());

    await assert.rejects(
      frames(handler, { interrupt_responses: {} }),
      /No interrupted run to resume/,
    );
  });

  test("an interrupted run resumes on its answered state", async () => {
    const item = approval("call_1");
    const state = new FakeState([item]);
    const runner = new ReplayRunner(
      new FakeRun([], { interruptions: [item], state }),
      new FakeRun([textDelta("resumed")]),
    );

    const handler = handlerWith(runner);
    const first = await frames(handler, { messages: [] });
    const second = await frames(handler, {
      interrupt_responses: { call_1: { value: true, source: "option" } },
    });

    const [firstFrame] = first;
    assert.ok(firstFrame !== undefined && "interrupt" in firstFrame.data);
    assert.deepEqual(second, [{ data: { data: "resumed" } }]);
    // The answer was applied to the stashed state, which the resume ran on.
    assert.deepEqual(state.approved, [item]);
    assert.equal(runner.inputs[1], state);
  });

  test("a rejected approval is recorded as rejected", async () => {
    const item = approval("call_1");
    const state = new FakeState([item]);
    const runner = new ReplayRunner(
      new FakeRun([], { interruptions: [item], state }),
      new FakeRun([]),
    );

    const handler = handlerWith(runner);
    await frames(handler, { messages: [] });
    await frames(handler, {
      interrupt_responses: { call_1: { value: false, source: "option" } },
    });

    assert.deepEqual(state.rejected, [item]);
  });

  test("the slot empties once resumed", async () => {
    const item = approval("call_1");
    const runner = new ReplayRunner(
      new FakeRun([], { interruptions: [item], state: new FakeState([item]) }),
      new FakeRun([textDelta("resumed")]),
    );

    const handler = handlerWith(runner);
    await frames(handler, { messages: [] });
    await frames(handler, {
      interrupt_responses: { call_1: { value: true, source: "option" } },
    });

    await assert.rejects(
      frames(handler, {
        interrupt_responses: { call_1: { value: true, source: "option" } },
      }),
      /No interrupted run to resume/,
    );
  });

  test("a resume that interrupts again can resume again", async () => {
    const first = approval("call_1");
    const second = approval("call_2");
    const runner = new ReplayRunner(
      new FakeRun([], {
        interruptions: [first],
        state: new FakeState([first]),
      }),
      new FakeRun([], {
        interruptions: [second],
        state: new FakeState([second]),
      }),
      new FakeRun([textDelta("done")]),
    );

    const handler = handlerWith(runner);
    await frames(handler, { messages: [] });
    await frames(handler, {
      interrupt_responses: { call_1: { value: true, source: "option" } },
    });
    const third = await frames(handler, {
      interrupt_responses: { call_2: { value: true, source: "option" } },
    });

    assert.deepEqual(third, [{ data: { data: "done" } }]);
  });
});

describe("sendFile", () => {
  test("a name that is not a string is refused", () => {
    assert.throws(
      () => sendFile(1 as unknown as string, PNG_BYTES),
      /name must be a string, not number/,
    );
  });

  test("an empty name is refused", () => {
    assert.throws(() => sendFile("", PNG_BYTES), /name must not be empty/);
  });

  test("data that is not a Uint8Array is refused", () => {
    assert.throws(
      () => sendFile("chart.png", "bytes" as unknown as Uint8Array),
      /data must be a Uint8Array/,
    );
  });

  test("empty data is refused", () => {
    assert.throws(
      () => sendFile("chart.png", new Uint8Array()),
      /data must not be empty/,
    );
  });

  test("a refused file is not queued", async () => {
    assert.throws(() => sendFile("chart.png", new Uint8Array()));
    const handler = handlerWith(
      new ReplayRunner(new FakeRun([textDelta("clean")])),
    );

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "clean" } },
    ]);
  });
});
