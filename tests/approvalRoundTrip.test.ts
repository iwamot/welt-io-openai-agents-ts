/**
 * The adapters against the approval machinery they translate, over the
 * real SDK.
 *
 * The unit tests either side of the wire work on items written by hand;
 * this drives the runner itself — over a scripted model, so no network is
 * needed — to pin what the two ends have to agree on: the approval a run
 * stops on becomes the question Welt renders, and the answers applied to
 * the state resume the run with the decision each stands for.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AgentInputItem,
  Model,
  ModelRequest,
  ModelResponse,
  protocol,
  RunState,
} from "@openai/agents";
import { Agent, run, setTracingDisabled, tool } from "@openai/agents";
import { z } from "zod";
import type { InterruptAnswer, RenderableEvent } from "../src/index.ts";
import { decodeInterruptResponses, renderableEvents } from "../src/index.ts";

setTracingDisabled(true);

const CSV = Buffer.from("fruit,count\napple,3\n").toString("base64");

const ran: string[] = [];

const risky = tool({
  name: "risky",
  description: "Do something risky.",
  parameters: z.object({ action: z.string() }),
  needsApproval: true,
  execute: ({ action }) => {
    ran.push(action);
    return [
      { type: "text", text: `did ${action}` },
      {
        type: "file",
        file: { data: CSV, mediaType: "text/csv", filename: "out.csv" },
      },
    ];
  },
});

/**
 * Calls the gated tool on its first turn, closes on the second.
 *
 * The input of every turn is kept, so a test can read what the resumed
 * model was told about the tool call it never saw finish.
 */
class ScriptedModel implements Model {
  seenInputs: (string | AgentInputItem[])[] = [];

  getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("the round trip streams");
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<protocol.StreamEvent> {
    this.seenInputs.push(request.input);
    let output: protocol.OutputModelItem[];
    if (this.seenInputs.length === 1) {
      output = [
        {
          type: "function_call",
          callId: "call_1",
          name: "risky",
          arguments: '{"action": "wipe"}',
        },
      ];
    } else {
      // A real backend streams the text ahead of the completed response
      // that repeats it.
      yield { type: "output_text_delta", delta: "Done." };
      output = [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done." }],
        },
      ];
    }
    yield {
      type: "response_done",
      response: {
        id: "resp_1",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        output,
      },
    };
  }
}

type Interrupted = {
  agent: Agent;
  model: ScriptedModel;
  events: RenderableEvent[];
  state: RunState<undefined, Agent>;
};

/** Run one turn to its approval stop. */
async function interrupted(): Promise<Interrupted> {
  ran.length = 0;
  const model = new ScriptedModel();
  const agent = new Agent({ name: "round-trip", model, tools: [risky] });
  const result = await run(agent, "please wipe", { stream: true });
  const events = await Array.fromAsync(renderableEvents(result));
  return { agent, model, events, state: result.state };
}

/** Answer the stop and stream the run to its end. */
async function resumed(
  stopped: Interrupted,
  answers: Record<string, InterruptAnswer>,
): Promise<{ seen: string | AgentInputItem[]; events: RenderableEvent[] }> {
  const result = await run(
    stopped.agent,
    decodeInterruptResponses(answers, stopped.state),
    { stream: true },
  );
  const events = await Array.fromAsync(
    renderableEvents(result, { filesFrom: ["risky"] }),
  );
  const seen = stopped.model.seenInputs.at(-1);
  assert.ok(seen !== undefined);
  return { seen, events };
}

function functionCallResults(
  seen: string | AgentInputItem[],
): protocol.FunctionCallResultItem[] {
  assert.ok(Array.isArray(seen));
  return seen.filter(
    (item): item is protocol.FunctionCallResultItem =>
      "type" in item && item.type === "function_call_result",
  );
}

describe("the approval round trip", () => {
  test("the stop asks one question per approval", async () => {
    const { events } = await interrupted();

    // The gated call streams as an ordinary tool-use indicator first; the
    // question that gates it ends the stream.
    assert.deepEqual(events, [
      { current_tool_use: { toolUseId: "call_1", name: "risky" } },
      {
        interrupt: {
          id: "call_1",
          name: "risky",
          reason: {
            message: 'May I run `risky`?\n```\n{\n  "action": "wipe"\n}\n```',
            approve: {},
            reject: {},
          },
        },
      },
    ]);
    assert.deepEqual(ran, []); // the tool waits on the answer
  });

  test("approval runs the tool and releases its files", async () => {
    const stopped = await interrupted();

    const { events } = await resumed(stopped, {
      call_1: { value: true, source: "option" },
    });

    assert.deepEqual(ran, ["wipe"]);
    assert.ok(
      events.some(
        (event) =>
          "tool_result" in event &&
          event.tool_result.toolUseId === "call_1" &&
          event.tool_result.status === "success",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          "file" in event &&
          event.file.name === "out.csv" &&
          event.file.bytes === CSV,
      ),
    );
    assert.ok(
      events.some((event) => "data" in event && event.data === "Done."),
    );
  });

  test("rejection keeps the tool unrun", async () => {
    const stopped = await interrupted();

    const { seen } = await resumed(stopped, {
      call_1: { value: false, source: "option" },
    });

    assert.deepEqual(ran, []);
    // The model is told the call was rejected, as the call's output.
    const results = functionCallResults(seen);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.callId, "call_1");
  });

  test("a button this adapter never built rejects too", async () => {
    const stopped = await interrupted();

    await resumed(stopped, {
      call_1: { value: "something else", source: "option" },
    });

    assert.deepEqual(ran, []);
  });

  test("an unasked question cannot be answered", async () => {
    const stopped = await interrupted();

    assert.throws(
      () =>
        decodeInterruptResponses(
          { call_404: { value: true, source: "option" } },
          stopped.state,
        ),
      /call_404/,
    );
  });
});

describe("a finished run", () => {
  test("has no questions left to ask", async () => {
    ran.length = 0;
    const model = new ScriptedModel();
    // Two turns, no approval: the tool is not gated on this agent.
    const free = tool({
      name: "risky",
      description: "Do something risky.",
      parameters: z.object({ action: z.string() }),
      execute: ({ action }) => {
        ran.push(action);
        return `did ${action}`;
      },
    });
    const agent = new Agent({ name: "free-run", model, tools: [free] });
    const result = await run(agent, "please wipe", { stream: true });
    const events = await Array.fromAsync(renderableEvents(result));
    assert.deepEqual(ran, ["wipe"]);
    assert.deepEqual(
      events.filter((event) => "interrupt" in event),
      [],
    );
    assert.ok(
      events.some((event) => "data" in event && event.data === "Done."),
    );
  });
});
