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

`weltAgent` builds the whole AgentCore Runtime invocation handler for an agent Welt drives, so a deployable is your agent plus one mount line:

```ts
import { Agent } from "@openai/agents";
import { weltAgent } from "@welt-io/openai-agents/agentcore";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

const app = new BedrockAgentCoreApp({
  invocationHandler: weltAgent(new Agent({ name: "assistant" })),
});

app.run();
```

See [`examples/agent`](examples/agent) for the full version — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and human-approval tools), with the model on Amazon Bedrock's OpenAI-compatible endpoint instead of the OpenAI platform, wired in through the `runner` option. The sections below cover the handler and the adapters it wires in.

## Supported Versions

### Welt

While both are 0.x, a @welt-io/openai-agents 0.Y release supports Welt v0.Y. From 1.0 on, a release supports any Welt release that shares its major version, and the minor versions move independently. Support is best effort either way, and other combinations come with no guarantee.

### OpenAI Agents SDK

The badge at the top states the range this release installs against. Every push and pull request runs the suite at both ends of it: the declared floor, and the newest release CI has picked up. That is best effort rather than a guarantee — the floor is where the suite was last seen to pass, so a later release may raise it, and no ceiling is declared at all.

The badge follows the current release. For the range an older release declared, read that release's own metadata on npm.

Something misbehaving inside that range is worth an [issue](https://github.com/iwamot/welt-io-openai-agents-ts/issues).

## API

The wire between Welt and the agent is JSON, specified by [Welt's wire contract](https://github.com/iwamot/welt/blob/main/docs/wire.md) — plain OpenAI Agents SDK values do not fit it in either direction. Two functions adapt the inbound payload, one the outbound stream. `weltAgent` wires all three into the invocation handler; reach for them directly when your handler needs a shape of its own.

### Handler

#### `weltAgent(agent, { runner, filesFrom })`

Builds the invocation handler `BedrockAgentCoreApp` takes. It reads which envelope Welt sent — Converse-shaped `messages` for a conversation turn, `interrupt_responses` for the answers that resume an interrupted run — runs the agent through the runner, and yields the events Welt renders, each wrapped as the SSE frame the AgentCore Runtime SDK emits.

The `runner` is where a model provider or run config lives — omitted, a default `Runner` resolves models against the OpenAI platform; the [example agent](examples/agent) hands one pointed at Bedrock's OpenAI-compatible endpoint. Every turn runs on the messages Welt sends: the Slack thread is the source of truth for conversation history, and the payload carries it whole. An interrupted run's state waits inside the handler for its answers — one slot, resume-only, living and dying with the session's microVM (recycled on idle timeout, 8 hours at most); resuming after that throws, which Welt renders as its resume-failure notice. `filesFrom` passes through to `renderableEvents` below.

#### `sendFile(name, data)`

Queues one file for the Slack thread from inside a tool, riding the wire beside the reply being streamed. On Bedrock's OpenAI-compatible endpoint this is the one road a tool's file has — the endpoint takes tool output only as a string — and the model never sees what was sent either way, so a tool whose file matters to the conversation says what it holds in its result string; a model that never saw the content would describe the upload by making one up. Every turn starts with the queue empty, so a file a failed turn left behind never rides a later reply, and an empty name or empty bytes is refused where the tool is still on the stack — Slack refuses a zero-byte upload, and the whole reply fails with it.

### Inbound

#### `decodeMessages(messages)`

Turns Welt's Converse-shaped messages — built from the Slack thread, file bytes base64-encoded — into the input items that feed `run` as-is:

| Converse block | SDK input |
|---|---|
| Text | `input_text` (an assistant turn's text becomes the `output_text` of a completed assistant message) |
| Image | `input_image` (a data URL) |
| Document | `input_file` (a data URL, the document's name carried as `filename`) |
| Video | Refused — the SDK has no video input |

Each file-carrying block becomes the data URL the SDK expects in place of the Converse format token, and the base64 data stays base64 — a data URL carries it as it came. A video block throws rather than dropping silently: there is nothing to rebuild one into, and a silent drop would leave the model answering a conversation with a piece missing.

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

The interrupt ids are the tool calls' own ids, as emitted by `renderableEvents`; the state is stashed when an interrupt event goes by — `weltAgent` does this for you, and a handler of your own does the same.

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

One caveat: whether a tool may return file content at all is the model endpoint's call, not this adapter's. The OpenAI platform accepts it; Bedrock's OpenAI-compatible endpoint takes a tool's output only as a string and rejects the request otherwise — so on Bedrock a tool cannot hand the model a file, and a file for the thread goes on the wire as a `file` event beside the events this function produces — `sendFile` above is that road.

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

- **Resume is a state round trip.** An interrupted streamed run exposes its `RunState` as `result.state`; `weltAgent` keeps that round trip for you. Done by hand, the host app stashes it, applies the answers with `decodeInterruptResponses`, and runs the same agent again with the state as input. An in-memory stash works on AgentCore Runtime, where each session keeps its own microVM.
- **Welt resumes once every question is answered.** There is no partial resume on the wire, so the state's approvals are all applied in one call.
- **Approved tools run on the resumed stream.** Each tool output names its own tool on this SDK, so `renderableEvents` needs nothing beyond the stream itself — their files keep flowing on resume as-is.

## License

MIT
