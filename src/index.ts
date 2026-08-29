/**
 * The OpenAI Agents SDK (TypeScript) adapter for Welt's wire contract.
 *
 * Welt (https://github.com/iwamot/welt) drives an agent over plain JSON:
 * Converse-shaped `messages` (or `interrupt_responses` answering an
 * interrupted run) in, a stream of renderable events out. Plain OpenAI
 * Agents SDK values do not fit it in either direction:
 *
 * - Inbound, Welt sends Converse-shaped messages with base64-encoded file
 *   bytes, while a run consumes the SDK's input items, whose file parts
 *   carry data URLs. `decodeMessages` rebuilds each message accordingly.
 *   Welt resumes an interrupted run with a plain mapping of interrupt id
 *   to the chosen answer; the SDK resumes from the interrupted `RunState`
 *   instead of from a payload, so `decodeInterruptResponses` applies each
 *   answer to the state as the approval decision it stands for and
 *   returns the state for `run`.
 * - Outbound, a streamed run yields event objects Welt does not render.
 *   `renderableEvents` reduces the run to the events Welt renders, the
 *   files of the tools the agent names among them. A run that stops on
 *   tool approvals ends with one `interrupt` event per pending approval,
 *   its reason built here — the SDK's interrupts are tool approvals, not
 *   free-form questions, so the question's shape is this adapter's to
 *   decide, not the agent author's.
 *
 * What Welt sends is taken as correct. Welt builds the payload and checks
 * its own output against the wire contract before releasing it, so a
 * payload that departs from the contract is a bug on the sending side, not
 * an input to validate against runtime errors — the inbound parameter
 * types say what arrives, and a value that is not it surfaces as an
 * ordinary error from whatever touches it first. The one thing
 * `decodeMessages` does refuse is a content block of a kind Welt never
 * sends: a `toolUse` or `toolResult` is not a shape error but a forged
 * conversation turn, and rebuilt as history it would let whoever reached
 * the runtime put words the model treats as its own past actions into the
 * run.
 *
 * The reply stream is read as what the SDK's types say it is: a streamed
 * run yields a closed union of event objects, so each one is read for
 * what it is rather than guarded against shapes the SDK does not produce.
 * Only what Welt reads goes on the wire — an event carrying more than
 * that costs bandwidth for something the renderer discards, and an event
 * with nothing to render is not sent at all.
 */

import { Buffer } from "node:buffer";
import type {
  Agent,
  AgentInputItem,
  protocol,
  RunStreamEvent,
  RunToolApprovalItem,
  RunToolCallOutputItem,
} from "@openai/agents";
import { Runner } from "@openai/agents";

// The `type` of the warnings this package emits, which a
// `process.on("warning", ...)` listener reads as the warning's `name`.
const WARNING_TYPE = "WeltWarning";

// The media types the SDK's data URLs carry, by Converse format token.
const IMAGE_MIME_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  flv: "video/x-flv",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  three_gp: "video/3gpp",
  webm: "video/webm",
  wmv: "video/x-ms-wmv",
};

// A video format token is its own filename extension, with one exception:
// Converse spells 3GP `three_gp`. The endpoint types an input_file by the
// extension it is given, so the extension is what has to be right.
const VIDEO_EXTENSIONS: Record<string, string> = { three_gp: "3gp" };

const DOCUMENT_MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  md: "text/markdown",
  pdf: "application/pdf",
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// The inbound shapes, as far as the decoding below reads them. The wire's
// format tokens are Converse's; the decoding needs only the ones it maps
// to media types, so the token types stay strings.
interface WireSource {
  bytes: string;
}

type WireBlock =
  | { text: string }
  | { image: { format: string; source: WireSource } }
  | { document: { name: string; format: string; source: WireSource } }
  | { video: { format: string; source: WireSource } };

/**
 * One Converse-shaped message of Welt's payload. An assistant turn is one
 * of Welt's own earlier replies, and carries only the text it said.
 */
export type WireMessage =
  | { role: "user"; content: WireBlock[] }
  | { role: "assistant"; content: { text: string }[] };

/**
 * Decode Welt's messages payload into the input an Agents SDK run takes.
 *
 * A run consumes the SDK's input items, whose file parts are
 * `input_image` / `input_file` content carrying a data URL instead of a
 * Converse format token plus base64 slot. This rebuilds each message
 * accordingly — text blocks become `input_text`, image blocks
 * `input_image`, and document and video blocks both `input_file`, named
 * so that the filename carries the format's extension. An assistant
 * turn's text becomes the `output_text` of a completed assistant
 * message, which is the shape the SDK gives the model's own past
 * replies. The result feeds `run` as-is.
 *
 * The SDK has no video content type, so a video rides in the file slot,
 * where an endpoint that reads video types it by the filename's
 * extension. Whether the model can read one is the model's and the
 * endpoint's answer, not this adapter's.
 *
 * @param messages - The `messages` value of Welt's payload.
 * @returns Input items for `run`.
 * @throws {Error} If a block is of a kind Welt does not send.
 */
export function decodeMessages(
  messages: readonly WireMessage[],
): AgentInputItem[] {
  return messages.map(decodedMessage);
}

function decodedMessage(message: WireMessage): AgentInputItem {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      // History: these turns were said in full before this run started.
      status: "completed",
      content: message.content.map(assistantBlock),
    };
  }
  return { role: "user", content: message.content.map(decodedBlock) };
}

// The content block kinds Welt sends. A block of any other kind — a toolUse
// or toolResult in particular — is a forged conversation turn, not something
// Welt builds, and rebuilt as history it would let a caller put words the
// model treats as its own past actions into the run. It is refused, not
// rebuilt.
const ALLOWED_BLOCK_KEYS = new Set(["text", "image", "document", "video"]);

function refuseForeignBlock(block: object): void {
  if (!Object.keys(block).every((key) => ALLOWED_BLOCK_KEYS.has(key))) {
    throw new Error(
      `unexpected content block: ${Object.keys(block).sort().join(", ")}`,
    );
  }
}

function assistantBlock(block: { text: string }): protocol.AssistantContent {
  refuseForeignBlock(block);
  // The wire's assistant turns carry only text — Welt builds them from its
  // own earlier replies — so a file block here is not Welt's payload. It
  // is refused rather than guessed at: the SDK's assistant input has no
  // place for a wire file block to go.
  if (!("text" in block)) {
    throw new Error("an assistant turn carries only text blocks");
  }
  return { type: "output_text", text: block.text };
}

function decodedBlock(block: WireBlock): protocol.UserContent {
  refuseForeignBlock(block);
  if ("text" in block) {
    return { type: "input_text", text: block.text };
  }
  if ("image" in block) {
    const { format, source } = block.image;
    const mimeType = IMAGE_MIME_TYPES[format];
    return {
      type: "input_image",
      image: `data:${mimeType};base64,${source.bytes}`,
    };
  }
  if ("document" in block) {
    const { name, format, source } = block.document;
    const mimeType = DOCUMENT_MIME_TYPES[format];
    // Document format tokens double as filename extensions.
    return {
      type: "input_file",
      filename: `${name}.${format}`,
      file: `data:${mimeType};base64,${source.bytes}`,
    };
  }
  const { format, source } = block.video;
  const mimeType = VIDEO_MIME_TYPES[format];
  const extension = VIDEO_EXTENSIONS[format] ?? format;
  // A video block carries no name of its own, and Welt embeds at most one
  // video per payload, so a fixed name cannot collide with another.
  return {
    type: "input_file",
    filename: `video.${extension}`,
    file: `data:${mimeType};base64,${source.bytes}`,
  };
}

/**
 * One answer of Welt's resume payload: what it was, and where from. Every
 * question this adapter builds offers only Welt's own approve and reject
 * buttons, so the answer is always a pressed one, carrying back the
 * `true` or `false` they answer with.
 */
export interface InterruptAnswer {
  value: unknown;
  source: "option";
}

/**
 * What `decodeInterruptResponses` uses of the interrupted `RunState`.
 *
 * Importing the SDK's `RunState` to call three methods on it would bind
 * this signature to its generics for nothing. This names the methods
 * instead, and a `RunState` satisfies it.
 */
export interface InterruptedState {
  getInterruptions(): RunToolApprovalItem[];
  approve(approvalItem: RunToolApprovalItem): void;
  reject(approvalItem: RunToolApprovalItem): void;
}

/**
 * Apply Welt's interrupt answers to the interrupted run's state.
 *
 * Welt resumes an interrupted run with a payload mapping each interrupt
 * id to the answer a human chose in the thread and the widget it came
 * from. The SDK resumes from the `RunState` the interrupted run left
 * behind, answers recorded on it — so this applies each answer to its
 * pending approval and returns the state, which feeds `run` directly,
 * answering every pending question at once.
 *
 * An answer is one of the two decisions the question offered. A value
 * that carries neither came from no question this adapter built, and
 * rejecting is the direction that does not act on an answer nobody can
 * read.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @param state - The `RunState` the interrupted run left behind
 *   (`result.state`).
 * @returns The state passed in, every answer applied.
 * @throws {Error} If an answer names no pending approval of this state —
 *   resuming the wrong run acts on questions nobody was asked.
 */
export function decodeInterruptResponses<StateT extends InterruptedState>(
  responses: Readonly<Record<string, InterruptAnswer>>,
  state: StateT,
): StateT {
  const pending = new Map<string, RunToolApprovalItem>();
  for (const item of state.getInterruptions()) {
    const callId = approvalCallId(item);
    if (callId !== undefined) {
      pending.set(callId, item);
    }
  }
  for (const [interruptId, answer] of Object.entries(responses)) {
    const item = pending.get(interruptId);
    if (item === undefined) {
      throw new Error(`no pending approval for interrupt id: ${interruptId}`);
    }
    if (answer.value === true) {
      state.approve(item);
    } else {
      state.reject(item);
    }
  }
  return state;
}

/** The call id that identifies one pending approval on the wire. */
function approvalCallId(item: RunToolApprovalItem): string | undefined {
  const raw = item.rawItem;
  return "callId" in raw && typeof raw.callId === "string" && raw.callId !== ""
    ? raw.callId
    : undefined;
}

/** A `data` wire event: one text chunk of the reply. */
export interface TextEvent {
  data: string;
}

/** A `current_tool_use` wire event: a tool call started. */
export interface ToolUseEvent {
  current_tool_use: { toolUseId: string; name: string };
}

/** A `tool_result` wire event: a tool call finished. */
export interface ToolResultEvent {
  tool_result: { toolUseId: string; status: "success" };
}

/** A `file` wire event: a filename plus base64 bytes Welt uploads to Slack. */
export interface FileEvent {
  file: { name: string; bytes: string };
}

/** An `interrupt` wire event: the run paused for a human answer. */
export interface InterruptEvent {
  interrupt: { id: string; name: string; reason: InterruptReason };
}

/** The structured reason of the approval question this adapter builds. */
interface InterruptReason {
  message: string;
  approve: Record<string, never>;
  reject: Record<string, never>;
}

/** An event of the wire's renderable subset. */
export type RenderableEvent =
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | FileEvent
  | InterruptEvent;

/** Options for `renderableEvents`. */
export interface RenderableEventsOptions {
  /**
   * The names of the tools whose files become `file` events. Omitted, no
   * tool's files reach the thread.
   */
  filesFrom?: Iterable<string>;
}

/**
 * What `renderableEvents` reads from the streamed run.
 *
 * Importing the SDK's `StreamedRunResult` to iterate it and read one
 * member off it would bind this signature to its generics for nothing.
 * This names them instead, and a `StreamedRunResult` satisfies it.
 */
export interface StreamedRun extends AsyncIterable<RunStreamEvent> {
  readonly interruptions: RunToolApprovalItem[];
}

/**
 * Reduce a streamed run to the events Welt renders.
 *
 * Iterates the run's stream events and yields the wire's renderable
 * subset: text deltas and refusals (`data` — a refusal is the model's
 * reply too, rendered once from the completed message since the SDK
 * streams no refusal deltas), tool-use indicators (`current_tool_use` /
 * `tool_result`, slimmed so tool output stays off the wire), and files
 * (`file` — the file and image content a tool named in `filesFrom`
 * returned). Reasoning items and everything else are dropped. A run that
 * stops on tool approvals ends with one `interrupt` event per pending
 * approval, read from the run after its stream closes — the reason
 * renders in Slack as the call's name and arguments over the approve and
 * reject buttons Welt words itself.
 *
 * Which of the agent's files belong in the reply is the agent's call, so
 * a tool's files become `file` events only when the tool is named in
 * `filesFrom` — a tool that hands the model a file to read stays off the
 * wire unless it is listed. Each tool output names its own tool, so a
 * resumed run needs nothing beyond the stream itself.
 *
 * Each event carries only what Welt reads, and an event with nothing to
 * render — a delta the model left empty, a file with no bytes — is not
 * sent at all.
 *
 * @param run - The `StreamedRunResult` of `run(agent, input, { stream:
 *   true })`.
 * @param options - `filesFrom`: the names of the tools whose files
 *   become `file` events.
 * @yields The renderable wire events, in stream order.
 */
export async function* renderableEvents(
  run: StreamedRun,
  options?: RenderableEventsOptions,
): AsyncGenerator<RenderableEvent, void, undefined> {
  const filesFrom = new Set(options?.filesFrom ?? []);
  for await (const event of run) {
    if (event.type === "raw_model_stream_event") {
      // A delta the model left empty carries nothing to render.
      if (event.data.type === "output_text_delta" && event.data.delta !== "") {
        yield { data: event.data.delta };
      }
    } else if (event.type === "run_item_stream_event") {
      const item = event.item;
      if (item.type === "tool_call_item") {
        const rendered = toolUseEvent(item.rawItem);
        if (rendered !== null) {
          yield rendered;
        }
      } else if (item.type === "tool_call_output_item") {
        yield* toolResultEvents(item.rawItem, filesFrom);
      } else if (item.type === "message_output_item") {
        yield* refusalEvents(item.rawItem);
      }
    }
  }
  yield* interruptEvents(run.interruptions);
}

/**
 * Announce one tool call, if the wire can name it.
 *
 * The wire's indicator carries the call's id and the tool's name, which
 * only a function call has both of — a hosted tool's call has no id to
 * answer to, and Welt's agents gate and render function tools.
 */
function toolUseEvent(rawItem: protocol.ToolCallItem): ToolUseEvent | null {
  if (rawItem.type !== "function_call") {
    return null;
  }
  return {
    current_tool_use: { toolUseId: rawItem.callId, name: rawItem.name },
  };
}

function toolResultEvents(
  rawItem: RunToolCallOutputItem["rawItem"],
  filesFrom: ReadonlySet<string>,
): RenderableEvent[] {
  // Always "success": the SDK folds a failed tool into the text it sends
  // the model, and an exception that escapes that ends the run as an
  // `error` event instead of streaming a result.
  const events: RenderableEvent[] = [
    { tool_result: { toolUseId: rawItem.callId, status: "success" } },
  ];
  if (rawItem.type === "function_call_result" && filesFrom.has(rawItem.name)) {
    events.push(...fileEvents(rawItem.output, rawItem.name));
  }
  return events;
}

/**
 * Render a message's refusal parts.
 *
 * Text streams as deltas and is not repeated here; a refusal never
 * streams — the SDK has no refusal delta event — so the completed
 * message is where it renders, once.
 */
function refusalEvents(rawItem: protocol.AssistantMessageItem): TextEvent[] {
  const events: TextEvent[] = [];
  for (const part of rawItem.content) {
    if (part.type === "refusal" && part.refusal !== "") {
      events.push({ data: part.refusal });
    }
  }
  return events;
}

function interruptEvents(
  interruptions: readonly RunToolApprovalItem[],
): InterruptEvent[] {
  const events: InterruptEvent[] = [];
  for (const approval of interruptions) {
    const callId = approvalCallId(approval);
    if (callId === undefined) {
      // An approval that nothing can name cannot be answered, and a
      // question Welt cannot resume is worse than none.
      process.emitWarning(
        `Skipped an approval without a call id: ${approval.name ?? ""}`,
        WARNING_TYPE,
      );
      continue;
    }
    events.push({
      interrupt: {
        id: callId,
        name: approval.name ?? "",
        reason: approvalReason(approval),
      },
    });
  }
  return events;
}

/**
 * Build the reason that asks a human to decide on one tool approval.
 *
 * The SDK's interrupts are tool approvals — no agent code declares a
 * question of its own — so the question's shape is fixed here: the
 * call's name and arguments as the message, and the two decisions the
 * state resumes from asked of Welt by name, so that what approval is
 * called stays Welt's to say. Deliberately no free-text field: the SDK
 * runs an approved tool with its original arguments or skips it, so
 * typed text has nowhere to go — a field would collect answers that can
 * only reject, and one that reads as consent ("yes!") would reject all
 * the same.
 */
function approvalReason(approval: RunToolApprovalItem): InterruptReason {
  const name = approval.name;
  let message =
    name !== undefined && name !== ""
      ? `May I run \`${name}\`?`
      : "May I run this tool?";
  const formatted = formattedArguments(approval.arguments);
  if (formatted !== "") {
    message = `${message}\n\`\`\`\n${formatted}\n\`\`\``;
  }
  return { message, approve: {}, reject: {} };
}

/**
 * Format a tool call's arguments for the approval question's body.
 *
 * Pretty-printed when they parse and as they came when they do not — the
 * model wrote them, so a human deciding on the call sees them either
 * way. Empty when there is nothing to show.
 */
function formattedArguments(argumentsText: string | undefined): string {
  if (argumentsText === undefined || argumentsText === "") {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
  if (parsed === null) {
    return "";
  }
  if (typeof parsed === "object" && Object.keys(parsed).length === 0) {
    return "";
  }
  return JSON.stringify(parsed, null, 2);
}

// A media subtype is not a filename extension in general —
// `application/vnd.ms-excel` and `application/msword` have none in them — so
// extensions are keyed on the whole media type. The maps above supply every
// one the wire carries, so the two cannot drift; the rest are video types a
// tool may return, which the wire never carries here.
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [IMAGE_MIME_TYPES, DOCUMENT_MIME_TYPES].flatMap((mapping) =>
      Object.entries(mapping).map(([format, mediaType]) => [mediaType, format]),
    ),
  ),
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};

/**
 * Build `file` events from a tool output's file-carrying content.
 *
 * A tool's output is a string, one content part, or a list of input
 * parts, and the file and image parts among them carry their bytes as a
 * data URL, bare base64, or raw bytes with a media type. A part pointing
 * at its file instead — a file id, an http URL — carries nothing to
 * upload.
 */
function fileEvents(
  output: protocol.FunctionCallResultItem["output"],
  origin: string,
): FileEvent[] {
  if (typeof output === "string") {
    // A plain-text tool result carries no file.
    return [];
  }
  const parts = Array.isArray(output) ? output : [output];
  const events: FileEvent[] = [];
  for (const part of parts) {
    let event: FileEvent | null = null;
    if (part.type === "file") {
      event = fileEventFromFile(part.file, origin);
    } else if (part.type === "input_file") {
      event = fileEventFromInputFile(part, origin);
    } else if (part.type === "image") {
      event =
        part.image === undefined
          ? null
          : fileEventFromImage(part.image, origin);
    } else if (part.type === "input_image") {
      event =
        typeof part.image === "string"
          ? fileEventFromImage(part.image, origin)
          : null;
    }
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

/** Build a `file` event from a `file` part's value. */
function fileEventFromFile(
  file: protocol.ToolOutputFileContent["file"],
  origin: string,
): FileEvent | null {
  if (typeof file === "string") {
    const carried = carriedBytes(file);
    if (carried === null) {
      return null;
    }
    return fileEvent(
      `file.${extension(carried.mimeType)}`,
      carried.data,
      origin,
    );
  }
  if ("data" in file) {
    return fileEvent(file.filename, encodedBytes(file.data), origin);
  }
  // A URL or a file id points at the file; there is nothing to upload.
  return null;
}

/** Build a `file` event from an `input_file` part. */
function fileEventFromInputFile(
  part: {
    file?: string | { id: string } | { url: string } | undefined;
    filename?: string | undefined;
  },
  origin: string,
): FileEvent | null {
  if (typeof part.file !== "string") {
    return null;
  }
  const carried = carriedBytes(part.file);
  if (carried === null) {
    return null;
  }
  const name =
    part.filename !== undefined && part.filename !== ""
      ? part.filename
      : `file.${extension(carried.mimeType)}`;
  return fileEvent(name, carried.data, origin);
}

/** Build a `file` event from an image value. */
function fileEventFromImage(
  image: protocol.ToolOutputImage["image"],
  origin: string,
): FileEvent | null {
  if (typeof image === "string") {
    const dataUrl = dataUrlParts(image);
    // A bare string that is not a data URL is a URL — a pointer, with
    // nothing to upload.
    if (dataUrl === null) {
      return null;
    }
    return fileEvent(
      `image.${extension(dataUrl.mimeType)}`,
      dataUrl.data,
      origin,
    );
  }
  if (image !== undefined && "data" in image) {
    return fileEvent(
      `image.${extension(image.mediaType)}`,
      encodedBytes(image.data),
      origin,
    );
  }
  return null;
}

/**
 * Read the bytes a file string carries, as the SDK reads it: a data URL
 * or bare base64 is the file itself, anything else points at it.
 */
function carriedBytes(
  file: string,
): { mimeType: string | undefined; data: string } | null {
  const dataUrl = dataUrlParts(file);
  if (dataUrl !== null) {
    return dataUrl;
  }
  if (/^[A-Za-z0-9+/=]+$/.test(file)) {
    return { mimeType: undefined, data: file };
  }
  return null;
}

/** Base64-encode bytes that may already be base64. */
function encodedBytes(data: string | Uint8Array): string {
  return typeof data === "string" ? data : Buffer.from(data).toString("base64");
}

/** Split a data URL into its media type and base64 payload. */
function dataUrlParts(url: string): { mimeType: string; data: string } | null {
  if (!url.startsWith("data:")) {
    return null;
  }
  const separator = url.indexOf(",");
  if (separator === -1) {
    return null;
  }
  const head = url.slice(5, separator);
  if (!head.endsWith(";base64")) {
    return null;
  }
  return {
    mimeType: head.slice(0, -";base64".length),
    data: url.slice(separator + 1),
  };
}

/** Pick a filename extension for a media type. */
function extension(mimeType: string | undefined): string {
  const slash = mimeType?.indexOf("/") ?? -1;
  const mediaType = mimeType !== undefined && slash !== -1 ? mimeType : "";
  const byMediaType = EXTENSION_BY_MEDIA_TYPE[mediaType];
  if (byMediaType !== undefined) {
    return byMediaType;
  }
  const subtype = mediaType.slice(slash + 1);
  return /^[a-z0-9]+$/.test(subtype) ? subtype : "bin";
}

/**
 * Build a `file` wire event, which Welt uploads to the Slack thread.
 *
 * @param name - The upload filename, extension included.
 * @param data - The file's base64 bytes.
 * @param origin - The tool that returned the file, for the warning an
 *   empty one leaves behind.
 * @returns The `file` event, or null for a file with no bytes.
 */
function fileEvent(
  name: string,
  data: string,
  origin: string,
): FileEvent | null {
  if (data === "") {
    // Slack refuses a zero-byte upload, and the whole reply fails with it,
    // so an empty file does not go on the wire.
    process.emitWarning(
      `Skipped an empty file from ${origin}: ${name}`,
      WARNING_TYPE,
    );
    return null;
  }
  return { file: { name, bytes: data } };
}

/** One streamed run: what `Runner.run(..., { stream: true })` returns. */
export interface ResumableRun extends StreamedRun {
  readonly state: InterruptedState;
}

/** What `startReply` takes beside the agent and the payload. */
export interface StartReplyOptions {
  /**
   * The runner that starts the run — the place a model provider or run
   * config lives. Omitted, a default `Runner` is constructed, which
   * resolves models against the OpenAI platform.
   */
  runner?: Runner;
  /**
   * The state of the run being resumed, held by the caller since the
   * stop that raised it. Required when the payload carries answers, and
   * unused otherwise.
   */
  state?: InterruptedState;
}

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

/**
 * Start the run that replies to the payload Welt sent.
 *
 * ```ts
 * const run = await startReply(agent, payload, { runner, state });
 * for await (const event of renderableEvents(run, { filesFrom })) {
 *   yield { data: event };
 * }
 * ```
 *
 * A conversation turn runs on the messages Welt sends, because the Slack
 * thread is the source of truth for conversation history and the payload
 * carries it whole. A resume runs on `state` — the state of the run that
 * raised the interrupts — with the answers applied to it here.
 *
 * The run comes back rather than its events, because a run that stops for
 * approval leaves its `state` behind and the caller is the one who knows
 * where to keep it, and for how long.
 *
 * @param agent - The agent to run.
 * @param payload - Welt's invocation payload.
 * @param options - `runner`: the runner that starts the run; `state`: the
 *   run being resumed.
 * @returns The streamed run, for `renderableEvents` to reduce.
 * @throws {Error} If the payload carries answers and no `state` came with
 *   them — there is no run to resume.
 */
export async function startReply(
  agent: Agent,
  payload: unknown,
  options?: StartReplyOptions,
): Promise<ResumableRun> {
  const runner = options?.runner ?? new Runner();
  const envelope = payload as WeltPayload;

  if ("interrupt_responses" in envelope) {
    const state = options?.state;
    if (state === undefined) {
      throw new Error("startReply was given answers but no state to resume.");
    }
    return await startRun(
      runner,
      agent,
      decodeInterruptResponses(envelope.interrupt_responses, state),
    );
  }
  return await startRun(runner, agent, decodeMessages(envelope.messages));
}

/** Start one streamed run on a turn's input. */
async function startRun(
  runner: Runner,
  agent: Agent,
  input: ReturnType<typeof decodeMessages> | InterruptedState,
): Promise<ResumableRun> {
  // The one cast in this module: an interrupted state going back into
  // `run` is the very state the run handed out, so the SDK's own input
  // type for it holds by construction.
  return await runner.run(agent, input as Parameters<Runner["run"]>[1], {
    stream: true,
  });
}
