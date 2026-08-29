# @welt-io/openai-agents

[![npm](https://img.shields.io/npm/v/%40welt-io%2Fopenai-agents.svg)](https://www.npmjs.com/package/@welt-io/openai-agents)
[![node](https://img.shields.io/node/v/%40welt-io%2Fopenai-agents.svg)](https://www.npmjs.com/package/@welt-io/openai-agents)
[![@openai/agents](https://img.shields.io/npm/dependency-version/%40welt-io%2Fopenai-agents/peer/%40openai%2Fagents.svg)](https://www.npmjs.com/package/@openai/agents)

The [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (TypeScript) adapter for [Welt](https://github.com/iwamot/welt)'s wire contract.

## Install

```bash
npm install @welt-io/openai-agents
```

`@openai/agents` comes with it as a peer dependency: the input items this package builds and the stream events it reads are the SDK's own types.

## Usage

`startReply` and `renderableEvents` are the wiring between Welt's payload and an OpenAI Agents run, so a deployable is your agent plus a short handler:

```ts
import { Agent } from "@openai/agents";
import { renderableEvents, startReply } from "@welt-io/openai-agents";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

const agent = new Agent({ name: "assistant" });

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: unknown) {
      const run = await startReply(agent, payload);
      for await (const event of renderableEvents(run)) {
        yield { data: event };
      }
    },
  },
});

app.run();
```

An agent with approval tools keeps the run states it needs to resume; [`examples/agent`](examples/agent) shows that — a Map under the interrupt ids, filled as the stops go by and emptied when their answers arrive.

See [`examples/agent`](examples/agent) for the full version — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and human-approval tools), with the model on Amazon Bedrock's OpenAI-compatible endpoint instead of the OpenAI platform, wired in through the `runner` option. The sections below cover the handler and the adapters it wires in.

## Supported Versions

### Welt

While both are 0.x, a @welt-io/openai-agents 0.Y release supports Welt v0.Y. From 1.0 on, a release supports any Welt release that shares its major version, and the minor versions move independently. Support is best effort either way, and other combinations come with no guarantee.

### OpenAI Agents SDK

The badge at the top states the range this release installs against. Every push and pull request runs the suite at both ends of it: the declared floor, and the newest release CI has picked up. That is best effort rather than a guarantee — the floor is where the suite was last seen to pass, so a later release may raise it, and no ceiling is declared at all.

The badge follows the current release. For the range an older release declared, read that release's own metadata on npm.

Something misbehaving inside that range is worth an [issue](https://github.com/iwamot/welt-io-openai-agents-ts/issues).

## API

The wire between Welt and the agent is JSON, specified by [Welt's wire contract](https://github.com/iwamot/welt/blob/main/docs/wire.md) — plain OpenAI Agents SDK values do not fit it in either direction. Two functions adapt the inbound payload, one the outbound stream. `startReply` wires the inbound pair into a run; reach for them directly when your handler needs a shape of its own — messages to edit before the run, an agent to run some other way.

### Reply

#### `startReply(agent, payload, { runner, state })`

Starts the run that replies to Welt's payload. It reads which envelope Welt sent — Converse-shaped `messages` for a conversation turn, `interrupt_responses` for the answers that resume an interrupted run — decodes it, and runs the agent through the runner on the result. What comes back is the streamed run, for `renderableEvents` to reduce.

The `runner` is where a model provider or run config lives — omitted, a default `Runner` resolves models against the OpenAI platform; the [example agent](examples/agent) hands one pointed at Bedrock's OpenAI-compatible endpoint. A conversation turn runs on the messages Welt sends, because the Slack thread is the source of truth for conversation history and the payload carries it whole. A resume runs on `state`, the state of the run that raised the interrupts, with the answers applied to it — answers with no `state` beside them throw.

The run comes back rather than its events because a run that stops for approval leaves its `state` behind, and where to keep it — and for how long an unanswered approval stays answerable — is the agent's to decide. Nothing is held here.

### Inbound

#### `decodeMessages(messages)`

Turns Welt's Converse-shaped messages — built from the Slack thread, file bytes base64-encoded — into the input items that feed `run` as-is:

| Converse block | SDK input |
|---|---|
| Text | `input_text` (an assistant turn's text becomes the `output_text` of a completed assistant message) |
| Image | `input_image` (a data URL) |
| Document | `input_file` (a data URL, the document's name carried as `filename`) |
| Video | `input_file` (a data URL, named `video.<extension>`) |

Each file-carrying block becomes the data URL the SDK expects in place of the Converse format token, and the base64 data stays base64 — a data URL carries it as it came.

The SDK has no video content type, so a video rides in the file slot. An endpoint that reads video types it by the filename's extension, which is why the name matters: Converse spells 3GP `three_gp`, and the file is named `video.3gp` rather than after the token. Whether a video is read at all is the endpoint's and the model's answer — Amazon Bedrock's OpenAI-compatible endpoint accepts `.mp4`, `.webm`, `.mov`, `.avi`, and `.mkv` — and a refusal arrives as the error it is, rather than being anticipated here.

#### `decodeInterruptResponses(responses, state)`

Applies Welt's resume payload — a mapping of interrupt id to the answer a human chose and the widget it came from — to the `RunState` the interrupted run left behind, and returns that state, which feeds `run` directly, answering every pending question at once:

```ts
decodeInterruptResponses(payload.interrupt_responses, state);
const result = await run(agent, state, { stream: true });
```

The SDK resumes from the state rather than from a payload, which is why this adapter takes both arguments where most of its siblings take one. Each answer is one of the two buttons the question asked Welt for:

| Answer | Applied as |
|---|---|
| Welt's approve button (`true`) | `state.approve(...)` — the tool runs as the model called it |
| Welt's reject button (`false`) | `state.reject(...)` — the tool does not run; the model is told it was rejected |

An answer whose id names no pending approval of the state throws, since resuming the wrong run would act on questions nobody was asked.

The interrupt ids are the tool calls' own ids, as emitted by `renderableEvents`; the handler stashes `run.state` when an interrupt event goes by, under those ids.

#### What arrives is taken as correct

Welt builds the payload and checks its own output against the wire contract before releasing it, so these two functions do no field validation of their own. A payload that departs from the contract is a bug on the sending side rather than an input to guard against, and it surfaces as an ordinary error from whatever touches it first — here, or in the SDK or the model's endpoint further on.

The one thing `decodeMessages` refuses outright is a content block of a kind Welt never sends. A `messages` turn carries only `text`, `image`, `document`, and `video` blocks; a `toolUse` or `toolResult` block is not a malformed one of those but a forged conversation turn, and rebuilt into history it would let a caller that is not Welt put words the model treats as its own past tool calls and their results into the run. It throws. This is a trust-boundary check, not the field validation the contract otherwise saves you from.

### Outbound

#### `renderableEvents(result, { filesFrom })`

Reduces a streamed run — whose events carry values Welt does not render — to the events Welt renders:

| The run emits | On the wire | In the Slack thread |
|---|---|---|
| Text deltas and refusals | `data` | The streamed reply (a refusal is the model's reply too, rendered once from the completed message — the SDK streams no refusal deltas) |
| Tool calls and tool outputs | `current_tool_use` / `tool_result` | "Using tool" indicators (tool output stays off the wire) |
| File and image content a tool named in `filesFrom` returned | `file` | An uploaded file ([size limits](https://github.com/iwamot/welt/blob/main/docs/wire.md#limits)) |
| Pending tool approvals | `interrupt` | An approval question (see below) |

Reasoning items stay off the wire: models like gpt-oss think aloud before they answer, and the wire has no place for reasoning — only the answer streams.

A tool hands files to the model for either of two reasons — to have it read them, or to give them to the human — and only the agent knows which is which, so name the tools whose files belong in the thread:

```ts
for await (const event of renderableEvents(result, { filesFrom: ["create_sample_file"] })) {
```

A tool left out keeps its files to the model: one that reads a PDF for the model does not drop it into the thread as a side effect. A tool named there returns the file as file content, which the model reads and Welt uploads:

```ts
return [
  { type: "text", text: "Created sample.csv." },
  { type: "file", file: { data: csvBase64, mediaType: "text/csv", filename: "sample.csv" } },
];
```

Uploaded names come from the part's own `filename`; parts without one are named by their media type when a data URL carries it (`file.pdf`, `image.png`). A part pointing at its file instead — a file id, an http URL — carries nothing to upload and stays off the wire.

One caveat: whether a tool may return file content at all is the model endpoint's call, not this adapter's. The OpenAI platform accepts it, and so does Bedrock's `bedrock-mantle` endpoint on its `/openai/v1` path — the one the multimodal models are served from — through the Responses API. The same endpoint's `/v1` path takes a tool's output only as a string and rejects anything else, as does a tool message on the Chat Completions API either way.

Each event carries only what Welt reads, and an event with nothing to render — a delta the model left empty, a file with no bytes — is not sent at all.

## Gating tools with `needsApproval`

The SDK's interrupts are tool approvals: a tool declares `needsApproval: true` (or a function deciding per call), and the run pauses before the tool's `execute` starts — the tool itself carries no approval code, which is what lets a tool the agent did not write, from a library or an MCP server, be gated the same way. It works over Welt as-is:

```ts
const sampleDangerousAction = tool({
  name: "sample_dangerous_action",
  // ...
  needsApproval: true,
  execute: ({ action }) => `Ran: ${action}.`,
});
```

A run that stops on approvals ends its stream with one `interrupt` event per pending approval. There is no free-form interrupt in this SDK — no agent code declares a question of its own — so the question's shape is this adapter's, not the agent author's: the call's name and arguments as the message, over the approve and reject buttons it asks Welt for by name, so that what approval is called stays Welt's to say (and a deployment's to translate). Deliberately no free-text field: the SDK runs an approved tool with its original arguments or skips it, so typed text has nowhere to go — a field would collect answers that can only reject, and one that reads as consent ("yes!") would reject all the same. The [inbound table](#decodeinterruptresponsesresponses-state) shows what each answer does; [Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) covers the Slack side — how the question renders, who can answer, multiple questions, and expiry.

On the SDK side:

- **Resume is a state round trip.** An interrupted streamed run exposes its `RunState` as `run.state`. The host app stashes it, and hands it back to `startReply` with the answers, which applies them and runs the same agent again on it. An in-memory stash works on AgentCore Runtime, where each session keeps its own microVM.
- **Welt resumes once every question is answered.** There is no partial resume on the wire, so the state's approvals are all applied in one call.
- **Approved tools run on the resumed stream.** Each tool output names its own tool on this SDK, so `renderableEvents` needs nothing beyond the stream itself — their files keep flowing on resume as-is.

## License

MIT
