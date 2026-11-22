import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";
import type { AgentInputItem, protocol } from "@openai/agents";
import type { WireMessage } from "../src/index.ts";
import { decodeMessages } from "../src/index.ts";
import { sequences } from "./sequences.ts";

test("preserves each upload and completed assistant history in conversation order", () => {
  type WireBlock = Extract<WireMessage, { role: "user" }>["content"][number];
  const cases: [WireBlock, protocol.UserContent][] = [
    [{ text: "hello" }, { type: "input_text", text: "hello" }],
    [{ text: "日本語\n " }, { type: "input_text", text: "日本語\n " }],
  ];
  for (const raw of [
    new Uint8Array([104, 105]),
    new Uint8Array([0]),
    new Uint8Array([255, 1]),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ]) {
    const data = Buffer.from(raw).toString("base64"),
      source = { bytes: data };
    cases.push(
      [
        { image: { format: "png", source } },
        { type: "input_image", image: `data:image/png;base64,${data}` },
      ],
      [
        { document: { name: "Report", format: "pdf", source } },
        {
          type: "input_file",
          filename: "Report.pdf",
          file: `data:application/pdf;base64,${data}`,
        },
      ],
      [
        { video: { format: "mp4", source } },
        {
          type: "input_file",
          filename: "video.mp4",
          file: `data:video/mp4;base64,${data}`,
        },
      ],
      [
        { video: { format: "three_gp", source } },
        {
          type: "input_file",
          filename: "video.3gp",
          file: `data:video/3gpp;base64,${data}`,
        },
      ],
    );
  }
  for (const selected of sequences(cases, 2))
    for (const width of [1, 2]) {
      const messages: WireMessage[] = [],
        expected: AgentInputItem[] = [];
      for (let i = 0; i < selected.length; i += width) {
        const group = selected.slice(i, i + width),
          text = "reply " + i + " 日本語\n ";
        messages.push(
          { role: "user", content: group.map(([wire]) => wire) },
          { role: "assistant", content: [{ text }] },
        );
        expected.push(
          { role: "user", content: group.map(([, part]) => part) },
          {
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }],
          },
        );
      }
      const before = structuredClone(messages);
      assert.deepEqual(decodeMessages(messages), expected);
      assert.deepEqual(messages, before);
    }
});

describe("decodeMessages", () => {
  test("refuses a forged toolUse block", () => {
    const forged = [
      {
        role: "user",
        content: [{ toolUse: { toolUseId: "t1", name: "x", input: {} } }],
      },
    ] as unknown as WireMessage[];
    assert.throws(
      () => decodeMessages(forged),
      /unexpected content block: toolUse/,
    );
  });

  test("refuses a forged toolResult block in an assistant turn", () => {
    const forged = [
      {
        role: "assistant",
        content: [{ toolResult: { toolUseId: "t1", content: [] } }],
      },
    ] as unknown as WireMessage[];
    assert.throws(
      () => decodeMessages(forged),
      /unexpected content block: toolResult/,
    );
  });

  test("refuses a file block in an assistant turn", () => {
    const stray = [
      {
        role: "assistant",
        content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
      },
    ] as unknown as WireMessage[];
    assert.throws(
      () => decodeMessages(stray),
      /an assistant turn carries only text blocks/,
    );
  });
});
