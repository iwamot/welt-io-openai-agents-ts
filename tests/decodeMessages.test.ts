import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WireMessage } from "../src/index.ts";
import { decodeMessages } from "../src/index.ts";

describe("decodeMessages", () => {
  test("rebuilds a user text block as input_text", () => {
    assert.deepEqual(
      decodeMessages([{ role: "user", content: [{ text: "hello" }] }]),
      [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    );
  });

  test("rebuilds an assistant turn as a completed message", () => {
    assert.deepEqual(
      decodeMessages([{ role: "assistant", content: [{ text: "hi there" }] }]),
      [
        {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hi there" }],
        },
      ],
    );
  });

  test("rebuilds an image block as an input_image data URL", () => {
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
        },
      ]),
      [
        {
          role: "user",
          content: [
            { type: "input_image", image: "data:image/png;base64,aGk=" },
          ],
        },
      ],
    );
  });

  test("rebuilds a document block with its name as filename", () => {
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [
            {
              document: {
                name: "Report",
                format: "pdf",
                source: { bytes: "aGk=" },
              },
            },
          ],
        },
      ]),
      [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "Report.pdf",
              file: "data:application/pdf;base64,aGk=",
            },
          ],
        },
      ],
    );
  });

  test("keeps blocks of one message in order", () => {
    const decoded = decodeMessages([
      {
        role: "user",
        content: [
          {
            document: {
              name: "notes",
              format: "md",
              source: { bytes: "aGk=" },
            },
          },
          { text: "see the notes" },
          { image: { format: "jpeg", source: { bytes: "aGk=" } } },
        ],
      },
    ]);
    const [message] = decoded;
    assert.ok(
      message !== undefined &&
        "content" in message &&
        Array.isArray(message.content),
    );
    assert.deepEqual(
      message.content.map((part) => part.type),
      ["input_file", "input_text", "input_image"],
    );
  });

  test("turns a video block into an input_file named by its format", () => {
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [{ video: { format: "mp4", source: { bytes: "aGk=" } } }],
        },
      ]),
      [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "video.mp4",
              file: "data:video/mp4;base64,aGk=",
            },
          ],
        },
      ],
    );
  });

  test("names a video by its extension, not its format token", () => {
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [
            { video: { format: "three_gp", source: { bytes: "aGk=" } } },
          ],
        },
      ]),
      [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "video.3gp",
              file: "data:video/3gpp;base64,aGk=",
            },
          ],
        },
      ],
    );
  });

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
