/**
 * A small AgentCore agent that Welt can drive.
 *
 * Receives Welt's payload, feeds it to an OpenAI Agents SDK run, and
 * streams back the renderable subset of its stream — BedrockAgentCoreApp
 * emits each event as SSE, which Welt (https://github.com/iwamot/welt)
 * renders into Slack.
 *
 * `startReply` reads which envelope Welt sent (a conversation turn, or
 * the answers that resume an interrupted run), decodes it, and starts the
 * run; `renderableEvents` reduces what it streams. Keeping an interrupted
 * run until its buttons are answered is this file's job, below.
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

import { randomUUID } from "node:crypto";
import {
  Agent,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  tool,
} from "@openai/agents";
import type { InterruptedState } from "@welt-io/openai-agents";
import { renderableEvents, startReply } from "@welt-io/openai-agents";
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

const createSampleFile = tool({
  name: "create_sample_file",
  description: "Create a small sample CSV file.",
  parameters: z.object({}),
  // A tool returns a file as content parts beside its text, which reach
  // the model — and the Slack thread, because this tool is named in
  // `filesFrom` below.
  execute: () => [
    { type: "text" as const, text: "Created sample.csv." },
    {
      type: "file" as const,
      file: {
        data: Buffer.from("fruit,count\napple,3\nbanana,5\n").toString(
          "base64",
        ),
        mediaType: "text/csv",
        filename: "sample.csv",
      },
    },
  ],
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
    return [
      {
        type: "text" as const,
        text:
          `Published the approved draft as ${name}.md.` +
          " The publish flow is complete; nothing is left to approve.",
      },
      {
        type: "file" as const,
        file: {
          data: Buffer.from(draft).toString("base64"),
          mediaType: "text/markdown",
          filename: `${name}.md`,
        },
      },
    ];
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
    `Ran: ${action}. Completed successfully (simulated by this demo tool).`,
});

// Bedrock's OpenAI-compatible endpoint. BEDROCK_REGION names the region it
// is reached in; unset, the region the environment names is used (us-east-1
// is mantle's home region, for environments that set none). `||`, not `??`:
// an empty value means unset, like Welt's own variables. To run against
// another OpenAI-compatible service instead, change the base URL and the key
// it is paired with.
const REGION =
  process.env.BEDROCK_REGION ||
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "us-east-1";

const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
if (!apiKey) {
  throw new Error("AWS_BEARER_TOKEN_BEDROCK is not set.");
}

const provider = new OpenAIProvider({
  // The multimodal models live on this endpoint's `/openai/v1` path,
  // which is not the `/v1` the rest of it serves.
  baseURL: `https://bedrock-mantle.${REGION}.api.aws/openai/v1`,
  apiKey,
  // The Responses API rather than Chat Completions: a tool's file rides
  // its result there, and a tool message on the chat API carries text
  // alone.
  useResponses: true,
});

// Resolves the agent's model name against the endpoint. A `Runner` rather
// than the `run()` helper because the name is resolved per run, keeping
// this module free of top-level await — the CodeZip packager bundles to
// CommonJS, which cannot represent one.
const runner = new Runner({ modelProvider: provider });

const agent = new Agent({
  // Any model the account may invoke that serves `/openai/v1/responses`
  // and reads files; an empty MODEL_ID means unset, like Welt's own
  // variables.
  model: process.env.MODEL_ID || "google.gemma-4-31b",
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

// The tools whose files belong in the Slack thread. A tool left out keeps
// its files to the model.
const FILES_FROM = ["create_sample_file", "sample_draft_report"];

// The states of the runs that stopped for approval, under the ids of the
// approvals they stopped on — Welt sends those ids back when the buttons
// are answered. An entry lives as long as this process: AgentCore Runtime
// gives each session its own microVM, so a resume that arrives after it
// was recycled finds nothing and throws, which Welt renders as its
// resume-failure notice.
const interrupted = new Map<string, InterruptedState>();

/**
 * Take the run the answered approvals belong to out of the map.
 *
 * A stop's questions are answered together, so every id in one payload
 * names the same run — the first answered id found held settles which.
 * The whole stop leaves the map with it, before the resume runs. An
 * answered id the map no longer holds means this process lost the run,
 * so there is nothing left to resume.
 */
function resumed(answers: Readonly<Record<string, unknown>>): InterruptedState {
  const state = Object.keys(answers)
    .map((id) => interrupted.get(id))
    .find((held) => held !== undefined);
  if (state === undefined) {
    throw new Error("No interrupted run to resume in this session.");
  }
  for (const [id, held] of interrupted) {
    if (held === state) {
      interrupted.delete(id);
    }
  }
  return state;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: unknown) {
      const envelope = payload as {
        interrupt_responses?: Record<string, unknown>;
      };
      const answers = envelope.interrupt_responses;

      const run = await startReply(agent, payload, {
        runner,
        ...(answers === undefined ? {} : { state: resumed(answers) }),
      });

      for await (const event of renderableEvents(run, {
        filesFrom: FILES_FROM,
      })) {
        if ("interrupt" in event) {
          // The run stopped here, and its state is what answers this
          // question when the buttons come back.
          interrupted.set(event.interrupt.id, run.state);
        }
        // The AgentCore Runtime SDK puts a yielded object's `data` field
        // on the SSE `data:` line.
        yield { data: event };
      }
    },
  },
});

app.run();
