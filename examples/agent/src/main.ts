/**
 * A small AgentCore agent that Welt can drive.
 *
 * Receives Welt's payload, feeds it to an OpenAI Agents SDK run, and
 * yields the renderable subset of its stream — BedrockAgentCoreApp emits
 * each event as SSE, which Welt (https://github.com/iwamot/welt) renders
 * into Slack. The payload carries one of two envelopes: Converse-shaped
 * `messages` for a conversation turn, or `interrupt_responses` when a
 * human answered the approval buttons of an interrupted run.
 *
 * The model runs on Amazon Bedrock through the OpenAI-compatible
 * `bedrock-mantle` endpoint, so the OpenAI client needs nothing beyond a
 * different base URL and a Bedrock API key — no OpenAI account is
 * involved.
 *
 * This example is a standalone deployable; Welt drives it only through
 * the JSON wire contract, which @welt-io/openai-agents adapts in both
 * directions.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { RunState } from "@openai/agents";
import {
  Agent,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  tool,
} from "@openai/agents";
import type {
  FileEvent,
  InterruptAnswer,
  RenderableEvent,
  WireMessage,
} from "@welt-io/openai-agents";
import {
  decodeInterruptResponses,
  decodeMessages,
  renderableEvents,
} from "@welt-io/openai-agents";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

// The SDK traces to the OpenAI platform by default and asks for an OpenAI
// API key to do it; this agent runs on AWS credentials alone.
setTracingDisabled(true);

const currentTime = tool({
  name: "current_time",
  description: "Get the current date and time.",
  parameters: z.object({}),
  execute: () => new Date().toISOString(),
});

// Files the tools made this turn, on their way to the thread. Bedrock's
// OpenAI-compatible endpoint takes a tool's output only as a string — the
// file content parts the OpenAI platform accepts there are rejected as
// malformed — so a tool on this stack cannot hand its file to the model.
// It hands the thread the file directly instead: the tool queues it here,
// and the entrypoint puts it on the wire beside the tool's own result.
const pendingFiles: FileEvent["file"][] = [];

const createSampleFile = tool({
  name: "create_sample_file",
  description: "Create a small sample CSV file.",
  parameters: z.object({}),
  // The result string carries the file's exact content — it is the one
  // channel this endpoint gives the model, and a model that never saw the
  // content would describe the upload by making one up. The file itself
  // goes to the Slack thread.
  execute: () => {
    const csv = "fruit,count\napple,3\nbanana,5\n";
    pendingFiles.push({
      name: "sample.csv",
      bytes: Buffer.from(csv).toString("base64"),
    });
    return (
      "Created sample.csv and sent it to the Slack thread." +
      ` Its exact content is:\n${csv}`
    );
  },
});

/**
 * Name a report apart from every other report of the run.
 *
 * One turn can publish several reports ("apple and banana, separately"),
 * and the thread tells the uploads apart by name alone.
 */
function documentName(stem: string): string {
  return `${stem}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

const sampleDraftReport = tool({
  name: "sample_draft_report",
  description:
    "Publish a small report on a topic. Draft the full report body and " +
    "pass it as `draft`; a human reviews the draft before it is published.",
  parameters: z.object({
    topic: z.string().describe("The report topic."),
    draft: z.string().describe("The full report body, ready to publish."),
  }),
  // The sibling examples draft inside the tool and pause to show the
  // draft. This SDK pauses before the tool starts, and the question shows
  // the call's arguments — so here the model drafts, and the draft rides
  // the arguments into the question. What the human approved is what
  // publishes: an approved call resumes with the arguments it was shown
  // with, so no memoization guards the draft the way the siblings need.
  needsApproval: true,
  execute: ({ draft }) => {
    const name = documentName("report");
    pendingFiles.push({
      name: `${name}.md`,
      bytes: Buffer.from(draft).toString("base64"),
    });
    return (
      `Published the approved draft to the Slack thread as ${name}.md.` +
      " The publish flow is complete; nothing is left to approve."
    );
  },
});

const sampleDangerousAction = tool({
  name: "sample_dangerous_action",
  description:
    "Pretend to run a dangerous or irreversible action the user asked for.",
  parameters: z.object({
    action: z.string().describe("The action to pretend to run."),
  }),
  // Approval by declaration: `needsApproval` pauses the run before
  // `execute` starts, and @welt-io/openai-agents renders the pending
  // approval as a question in the Slack thread. Nothing here knows about
  // the approval — which is what lets a tool the agent did not write,
  // from a library or an MCP server, be gated the same way. Nothing is
  // actually executed.
  needsApproval: true,
  execute: ({ action }) =>
    `Ran: ${action}. (This example doesn't actually run anything.)`,
});

// Bedrock's OpenAI-compatible endpoint, in the region the environment
// names (us-east-1 is mantle's home region, for environments that set
// none). To run against another OpenAI-compatible service instead, change
// the base URL and the key it is paired with.
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
if (!apiKey) {
  throw new Error("AWS_BEARER_TOKEN_BEDROCK is not set.");
}

const provider = new OpenAIProvider({
  baseURL: `https://bedrock-mantle.${REGION}.api.aws/v1`,
  apiKey,
  // Chat Completions rather than Responses. This SDK sends assistant
  // history to the Responses API as output items, a form this endpoint's
  // validation rejects — it takes assistant turns only as plain
  // role/content messages, which is how the chat API carries all history.
  // Every turn after the first would otherwise fail. (The OpenAI platform
  // accepts both, so against it this line is a free choice.)
  useResponses: false,
});

// Resolves the agent's model name against the endpoint. A `Runner` rather
// than the `run()` helper because the name is resolved per run, keeping
// this module free of top-level await — the CodeZip packager bundles to
// CommonJS, which cannot represent one.
const runner = new Runner({ modelProvider: provider });

const agent = new Agent({
  // Any model on the endpoint's /v1/models listing the account may
  // invoke; an empty MODEL_ID means unset, like Welt's own variables.
  model: process.env.MODEL_ID || "openai.gpt-oss-120b",
  name: "welt-example",
  // A rejected approval reaches the model as the tool's result ("Tool
  // execution was not approved."), and models of several families read
  // right past it, reporting the action as completed. The rule exists
  // because nothing else in the conversation marks the call as unrun.
  instructions:
    'When a tool call\'s result says its execution "was not approved", ' +
    "that tool did not run. Say plainly that the action was not " +
    "performed — never describe it as completed, in progress, or " +
    "pending.",
  tools: [
    currentTime,
    createSampleFile,
    sampleDraftReport,
    sampleDangerousAction,
  ],
});

// Where an interrupted run waits for its answers. One slot is enough:
// AgentCore Runtime runs each session in its own microVM, so this process
// never serves two sessions. Resume only: a normal turn always runs on
// the messages Welt sends (the Slack thread is the source of truth for
// conversation history, so the state must not stand in for it). No
// persistence either — the slot lives and dies with the session's microVM
// (recycled on idle timeout, 8 hours at most).
let interruptedState: RunState<undefined, typeof agent> | null = null;

/**
 * Welt's payload, which carries one of the two envelopes.
 *
 * What Welt sends is taken as correct: it checks its own output against
 * the wire contract before sending it, so this says what arrives rather
 * than checking it. A payload carrying neither key is Welt's bug, and the
 * error it raises is reported as an `error` event by the SDK.
 */
type WeltPayload =
  | { messages: WireMessage[] }
  | { interrupt_responses: Record<string, InterruptAnswer> };

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async function* (payload: unknown) {
      const envelope = payload as WeltPayload;

      let result: Awaited<
        ReturnType<typeof runner.run<typeof agent, undefined>>
      >;
      if ("interrupt_responses" in envelope) {
        const state = interruptedState;
        interruptedState = null;
        if (state === null) {
          // The microVM was recycled while the buttons waited. The SDK
          // reports the throw as an `error` event, and Welt renders its
          // resume-failure notice.
          throw new Error("No interrupted run to resume in this session.");
        }
        result = await runner.run(
          agent,
          decodeInterruptResponses(envelope.interrupt_responses, state),
          { stream: true },
        );
      } else {
        result = await runner.run(agent, decodeMessages(envelope.messages), {
          stream: true,
        });
      }

      let interrupted = false;
      // Reduce the stream to the JSON-serializable events Welt renders.
      // Each one is wrapped as `{data: event}`: the AgentCore SDK treats a
      // yielded object's `data` field as the SSE data payload, so the
      // wrapper puts the wire event itself — text events included, whose
      // own `data` key would otherwise be mistaken for the envelope — on
      // the `data:` line.
      for await (const event of renderableEvents(result)) {
        if ("interrupt" in event) {
          interrupted = true;
        }
        yield { data: event } as { data: RenderableEvent };
        // The files the tools queued ride the wire beside their results —
        // see pendingFiles for why they do not ride the tool outputs.
        while (pendingFiles.length > 0) {
          const file = pendingFiles.shift();
          if (file !== undefined) {
            yield { data: { file } };
          }
        }
      }

      if (interrupted) {
        // Re-stashed on every interrupted stop, so a resume that
        // interrupts again keeps working.
        interruptedState = result.state;
      }
    },
  },
});

app.run();
