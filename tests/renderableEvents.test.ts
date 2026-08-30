import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  protocol,
  RunStreamEvent,
  RunToolApprovalItem,
} from "@openai/agents";
import {
  Agent,
  RunToolApprovalItem as ApprovalItem,
  RunItemStreamEvent,
  RunMessageOutputItem,
  RunRawModelStreamEvent,
  RunToolCallItem,
  RunToolCallOutputItem,
} from "@openai/agents";
import type { RenderableEventsOptions } from "../src/index.ts";
import { renderableEvents } from "../src/index.ts";

const agent = new Agent({ name: "test-agent" });

const CSV = "ZnJ1aXQsY291bnQKYXBwbGUsMwo="; // "fruit,count\napple,3\n"

function functionCall(
  overrides?: Partial<protocol.FunctionCallItem>,
): protocol.FunctionCallItem {
  return {
    type: "function_call",
    callId: "call_1",
    name: "make_file",
    arguments: "{}",
    ...overrides,
  };
}

function outputItem(
  output: protocol.FunctionCallResultItem["output"],
  overrides?: Partial<protocol.FunctionCallResultItem>,
): RunToolCallOutputItem {
  return new RunToolCallOutputItem(
    {
      type: "function_call_result",
      callId: "call_1",
      name: "make_file",
      status: "completed",
      output,
      ...overrides,
    },
    agent,
    output,
  );
}

function textDelta(delta: string): RunRawModelStreamEvent {
  return new RunRawModelStreamEvent({ type: "output_text_delta", delta });
}

async function rendered(
  events: readonly RunStreamEvent[],
  options?: RenderableEventsOptions,
  interruptions: RunToolApprovalItem[] = [],
) {
  const run = {
    interruptions,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
  return Array.fromAsync(renderableEvents(run, options));
}

describe("text", () => {
  test("a text delta becomes a data event", async () => {
    assert.deepEqual(await rendered([textDelta("hello")]), [{ data: "hello" }]);
  });

  test("an empty delta carries nothing to render", async () => {
    assert.deepEqual(await rendered([textDelta("")]), []);
  });

  test("other raw model events stay off the wire", async () => {
    assert.deepEqual(
      await rendered([
        new RunRawModelStreamEvent({ type: "response_started" }),
      ]),
      [],
    );
  });
});

describe("refusals", () => {
  test("a refusal renders once, from the completed message", async () => {
    const message = new RunMessageOutputItem(
      {
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "streamed already" },
          { type: "refusal", refusal: "I cannot help with that." },
        ],
      },
      agent,
    );
    assert.deepEqual(
      await rendered([
        new RunItemStreamEvent("message_output_created", message),
      ]),
      [{ data: "I cannot help with that." }],
    );
  });

  test("an empty refusal carries nothing to render", async () => {
    const message = new RunMessageOutputItem(
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "" }],
      },
      agent,
    );
    assert.deepEqual(
      await rendered([
        new RunItemStreamEvent("message_output_created", message),
      ]),
      [],
    );
  });
});

describe("tool calls", () => {
  test("a function call becomes a current_tool_use event", async () => {
    assert.deepEqual(
      await rendered([
        new RunItemStreamEvent(
          "tool_called",
          new RunToolCallItem(functionCall(), agent),
        ),
      ]),
      [{ current_tool_use: { toolUseId: "call_1", name: "make_file" } }],
    );
  });

  test("a hosted tool call has no id the wire can carry", async () => {
    assert.deepEqual(
      await rendered([
        new RunItemStreamEvent(
          "tool_called",
          new RunToolCallItem(
            { type: "hosted_tool_call", name: "web_search" },
            agent,
          ),
        ),
      ]),
      [],
    );
  });

  test("a tool output becomes a tool_result event", async () => {
    assert.deepEqual(
      await rendered([
        new RunItemStreamEvent("tool_output", outputItem("done")),
      ]),
      [{ tool_result: { toolUseId: "call_1", status: "success" } }],
    );
  });

  test("other run items stay off the wire", async () => {
    assert.deepEqual(
      await rendered([
        new RunItemStreamEvent(
          "reasoning_item_created",
          new RunMessageOutputItem(
            {
              role: "assistant",
              status: "in_progress",
              content: [{ type: "output_text", text: "thinking" }],
            },
            agent,
          ),
        ),
      ]),
      [],
    );
  });
});

describe("files", () => {
  const filesFrom = { filesFrom: ["make_file"] };

  test("files flow only from tools named in filesFrom", async () => {
    const output: protocol.FunctionCallResultItem["output"] = [
      { type: "input_file", file: `data:text/csv;base64,${CSV}` },
    ];
    assert.deepEqual(
      await rendered([
        new RunItemStreamEvent("tool_output", outputItem(output)),
      ]),
      [{ tool_result: { toolUseId: "call_1", status: "success" } }],
    );
    assert.deepEqual(
      await rendered(
        [new RunItemStreamEvent("tool_output", outputItem(output))],
        filesFrom,
      ),
      [
        { tool_result: { toolUseId: "call_1", status: "success" } },
        { file: { name: "file.csv", bytes: CSV } },
      ],
    );
  });

  test("an input_file part's filename names the upload", async () => {
    assert.deepEqual(
      await rendered(
        [
          new RunItemStreamEvent(
            "tool_output",
            outputItem([
              {
                type: "input_file",
                file: `data:text/csv;base64,${CSV}`,
                filename: "fruits.csv",
              },
            ]),
          ),
        ],
        filesFrom,
      ),
      [
        { tool_result: { toolUseId: "call_1", status: "success" } },
        { file: { name: "fruits.csv", bytes: CSV } },
      ],
    );
  });

  test("a string output carries no file", async () => {
    assert.deepEqual(
      await rendered(
        [new RunItemStreamEvent("tool_output", outputItem("plain text"))],
        filesFrom,
      ),
      [{ tool_result: { toolUseId: "call_1", status: "success" } }],
    );
  });

  test("a single file part with data and filename", async () => {
    assert.deepEqual(
      await rendered(
        [
          new RunItemStreamEvent(
            "tool_output",
            outputItem({
              type: "file",
              file: { data: CSV, mediaType: "text/csv", filename: "out.csv" },
            }),
          ),
        ],
        filesFrom,
      ),
      [
        { tool_result: { toolUseId: "call_1", status: "success" } },
        { file: { name: "out.csv", bytes: CSV } },
      ],
    );
  });

  test("a file part's raw bytes are encoded for the wire", async () => {
    assert.deepEqual(
      await rendered(
        [
          new RunItemStreamEvent(
            "tool_output",
            outputItem({
              type: "file",
              file: {
                data: new Uint8Array([104, 105]),
                mediaType: "text/plain",
                filename: "hi.txt",
              },
            }),
          ),
        ],
        filesFrom,
      ),
      [
        { tool_result: { toolUseId: "call_1", status: "success" } },
        { file: { name: "hi.txt", bytes: "aGk=" } },
      ],
    );
  });

  test("a file string is read as the SDK reads it", async () => {
    const asFileString = async (file: string) =>
      (
        await rendered(
          [
            new RunItemStreamEvent(
              "tool_output",
              outputItem({ type: "file", file }),
            ),
          ],
          filesFrom,
        )
      ).slice(1);
    // A data URL carries the bytes and their type.
    assert.deepEqual(await asFileString(`data:text/csv;base64,${CSV}`), [
      { file: { name: "file.csv", bytes: CSV } },
    ]);
    // Bare base64 carries the bytes alone.
    assert.deepEqual(await asFileString(CSV), [
      { file: { name: "file.bin", bytes: CSV } },
    ]);
    // Anything else points at the file; there is nothing to upload.
    assert.deepEqual(await asFileString("https://example.com/out.csv"), []);
  });

  test("pointer shapes carry nothing to upload", async () => {
    const events = await rendered(
      [
        new RunItemStreamEvent(
          "tool_output",
          outputItem([
            { type: "input_file", file: { id: "file_1" } },
            { type: "input_file", file: "https://example.com/out.csv" },
            { type: "input_file" },
            { type: "input_image", image: { id: "file_2" } },
            { type: "input_image" },
            { type: "input_text", text: "no file here" },
          ]),
        ),
        new RunItemStreamEvent(
          "tool_output",
          outputItem({ type: "file", file: { url: "https://example.com/f" } }),
        ),
        new RunItemStreamEvent(
          "tool_output",
          outputItem({
            type: "image",
            image: { url: "https://example.com/i" },
          }),
        ),
        new RunItemStreamEvent("tool_output", outputItem({ type: "image" })),
        new RunItemStreamEvent(
          "tool_output",
          outputItem({ type: "text", text: "just text" }),
        ),
      ],
      filesFrom,
    );
    assert.deepEqual(
      events.filter((event) => "file" in event),
      [],
    );
  });

  test("an image data URL becomes a named image file", async () => {
    assert.deepEqual(
      await rendered(
        [
          new RunItemStreamEvent(
            "tool_output",
            outputItem([
              { type: "input_image", image: "data:image/png;base64,aGk=" },
            ]),
          ),
          new RunItemStreamEvent(
            "tool_output",
            outputItem({ type: "image", image: "data:image/png;base64,aGk=" }),
          ),
          new RunItemStreamEvent(
            "tool_output",
            outputItem({ type: "image", image: "https://example.com/i.png" }),
          ),
        ],
        filesFrom,
      ),
      [
        { tool_result: { toolUseId: "call_1", status: "success" } },
        { file: { name: "image.png", bytes: "aGk=" } },
        { tool_result: { toolUseId: "call_1", status: "success" } },
        { file: { name: "image.png", bytes: "aGk=" } },
        { tool_result: { toolUseId: "call_1", status: "success" } },
      ],
    );
  });

  test("an image part's raw bytes are encoded for the wire", async () => {
    assert.deepEqual(
      await rendered(
        [
          new RunItemStreamEvent(
            "tool_output",
            outputItem({
              type: "image",
              image: { data: new Uint8Array([104, 105]) },
            }),
          ),
        ],
        filesFrom,
      ),
      [
        { tool_result: { toolUseId: "call_1", status: "success" } },
        { file: { name: "image.bin", bytes: "aGk=" } },
      ],
    );
  });

  test("media subtypes double as extensions, with the known exceptions", async () => {
    const named = async (file: string) =>
      (
        await rendered(
          [
            new RunItemStreamEvent(
              "tool_output",
              outputItem({ type: "file", file }),
            ),
          ],
          filesFrom,
        )
      ).slice(1);
    assert.deepEqual(await named("data:text/markdown;base64,aGk="), [
      { file: { name: "file.md", bytes: "aGk=" } },
    ]);
    assert.deepEqual(await named("data:text/plain;base64,aGk="), [
      { file: { name: "file.txt", bytes: "aGk=" } },
    ]);
    // A media subtype is not an extension in general, so the media types
    // the wire carries are named from the whole thing.
    assert.deepEqual(await named("data:application/msword;base64,aGk="), [
      { file: { name: "file.doc", bytes: "aGk=" } },
    ]);
    assert.deepEqual(await named("data:application/vnd.ms-excel;base64,aGk="), [
      { file: { name: "file.xls", bytes: "aGk=" } },
    ]);
    // The video formats the wire carries are named from the whole media
    // type too: two of them spell their subtype in a way no extension can
    // be taken from, and 3GP is spelled `three_gp` on the wire.
    assert.deepEqual(await named("data:video/x-flv;base64,aGk="), [
      { file: { name: "file.flv", bytes: "aGk=" } },
    ]);
    assert.deepEqual(await named("data:video/x-ms-wmv;base64,aGk="), [
      { file: { name: "file.wmv", bytes: "aGk=" } },
    ]);
    assert.deepEqual(await named("data:video/3gpp;base64,aGk="), [
      { file: { name: "file.3gp", bytes: "aGk=" } },
    ]);
    // A media type the wire never carries still gets its subtype, when
    // that reads as an extension.
    assert.deepEqual(await named("data:application/json;base64,aGk="), [
      { file: { name: "file.json", bytes: "aGk=" } },
    ]);
    // A subtype that is no extension falls back to bin.
    assert.deepEqual(
      await named("data:application/vnd.oasis.opendocument.text;base64,aGk="),
      [{ file: { name: "file.bin", bytes: "aGk=" } }],
    );
    // A media type with no slash names no subtype at all.
    assert.deepEqual(await named("data:hi;base64,aGk="), [
      { file: { name: "file.bin", bytes: "aGk=" } },
    ]);
  });

  test("malformed data URLs point at nothing", async () => {
    const events = await rendered(
      [
        new RunItemStreamEvent(
          "tool_output",
          outputItem({ type: "image", image: "data:image/png" }),
        ),
        new RunItemStreamEvent(
          "tool_output",
          outputItem({ type: "image", image: "data:image/png,aGk=" }),
        ),
      ],
      filesFrom,
    );
    assert.deepEqual(
      events.filter((event) => "file" in event),
      [],
    );
  });

  test("an empty file stays off the wire and leaves a warning", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "WeltWarning") {
        warnings.push(warning.message);
      }
    };
    process.on("warning", onWarning);
    try {
      const events = await rendered(
        [
          new RunItemStreamEvent(
            "tool_output",
            outputItem({ type: "file", file: "data:text/csv;base64," }),
          ),
        ],
        filesFrom,
      );
      assert.deepEqual(
        events.filter((event) => "file" in event),
        [],
      );
      // The warning is delivered on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(warnings, [
        "Skipped an empty file from make_file: file.csv",
      ]);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

describe("interrupts", () => {
  test("a pending approval ends the stream as an interrupt event", async () => {
    const approval = new ApprovalItem(
      functionCall({ arguments: '{"action": "wipe"}', name: "risky" }),
      agent,
    );
    assert.deepEqual(await rendered([], undefined, [approval]), [
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
  });

  test("empty and unparseable arguments shape the question body", async () => {
    const messageOf = async (approvalArguments: string) => {
      const events = await rendered([], undefined, [
        new ApprovalItem(
          functionCall({ arguments: approvalArguments, name: "risky" }),
          agent,
        ),
      ]);
      const [event] = events;
      assert.ok(event !== undefined && "interrupt" in event);
      return event.interrupt.reason.message;
    };
    // Nothing to show: no arguments, or arguments that parse to nothing.
    assert.equal(await messageOf(""), "May I run `risky`?");
    assert.equal(await messageOf("{}"), "May I run `risky`?");
    assert.equal(await messageOf("null"), "May I run `risky`?");
    // The model wrote these, so the human sees them as they came.
    assert.equal(
      await messageOf("not json"),
      "May I run `risky`?\n```\nnot json\n```",
    );
    // A bare JSON scalar still shows.
    assert.equal(await messageOf("42"), "May I run `risky`?\n```\n42\n```");
  });

  test("an approval the wire cannot name asks no question", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "WeltWarning") {
        warnings.push(warning.message);
      }
    };
    process.on("warning", onWarning);
    try {
      const events = await rendered([], undefined, [
        new ApprovalItem(
          { type: "hosted_tool_call", name: "web_search" },
          agent,
        ),
      ]);
      assert.deepEqual(events, []);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(warnings, [
        "Skipped an approval without a call id: web_search",
      ]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  test("an approval without even a name still warns", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "WeltWarning") {
        warnings.push(warning.message);
      }
    };
    process.on("warning", onWarning);
    try {
      const events = await rendered([], undefined, [
        new ApprovalItem(
          { type: "function_call", callId: "", name: "", arguments: "" },
          agent,
        ),
      ]);
      assert.deepEqual(events, []);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(warnings, ["Skipped an approval without a call id: "]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  test("a nameless approval with a call id asks the generic question", async () => {
    const events = await rendered([], undefined, [
      new ApprovalItem(
        { type: "function_call", callId: "call_9", name: "", arguments: "" },
        agent,
      ),
    ]);
    const [event] = events;
    assert.ok(event !== undefined && "interrupt" in event);
    assert.equal(event.interrupt.name, "");
    assert.equal(event.interrupt.reason.message, "May I run this tool?");
  });

  test("an approval whose raw item carries no name at all", async () => {
    const events = await rendered([], undefined, [
      new ApprovalItem(
        {
          type: "shell_call",
          callId: "call_9",
          status: "completed",
          action: { commands: [] },
        },
        agent,
      ),
    ]);
    const [event] = events;
    assert.ok(event !== undefined && "interrupt" in event);
    assert.equal(event.interrupt.name, "");
    assert.equal(event.interrupt.reason.message, "May I run this tool?");
  });
});
