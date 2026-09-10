import { describe, expect, test } from "bun:test";
import { SseWriter } from "../src/routes/messages.ts";

type Frame = { event: string; data: Record<string, unknown> };

function capture(): { writer: SseWriter; frames: Frame[] } {
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  const controller = {
    enqueue(chunk: Uint8Array) {
      const text = decoder.decode(chunk);
      const [eventLine, dataLine] = text.trim().split("\n");
      frames.push({
        event: eventLine!.replace("event: ", ""),
        data: JSON.parse(dataLine!.replace("data: ", "")),
      });
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { writer: new SseWriter(controller), frames };
}

describe("SseWriter", () => {
  test("emits a well-formed text stream", () => {
    const { writer, frames } = capture();
    writer.start("msg_1", "claude-sonnet-5");
    writer.delta({ type: "text", text: "Hel" });
    writer.delta({ type: "text", text: "lo" });
    writer.finish("end_turn", { input_tokens: 10, output_tokens: 2 });

    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[1]!.data.index).toBe(0);
    expect((frames[5]!.data.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
  });

  test("closes one block and opens the next when the kind changes", () => {
    const { writer, frames } = capture();
    writer.start("msg_2", "claude-sonnet-5");
    writer.delta({ type: "thinking", text: "hmm" });
    writer.delta({ type: "text", text: "answer" });
    writer.finish("end_turn", { input_tokens: 0, output_tokens: 0 });

    const starts = frames.filter((f) => f.event === "content_block_start");
    expect(starts).toHaveLength(2);
    expect((starts[0]!.data.content_block as Record<string, unknown>).type).toBe("thinking");
    expect(starts[0]!.data.index).toBe(0);
    expect((starts[1]!.data.content_block as Record<string, unknown>).type).toBe("text");
    expect(starts[1]!.data.index).toBe(1);
  });

  test("writes a tool call as start, one json delta and stop", () => {
    const { writer, frames } = capture();
    writer.start("msg_3", "claude-sonnet-5");
    writer.delta({ type: "text", text: "Looking that up." });
    writer.toolUse({ type: "tool_use", id: "toolu_1", name: "get weather", input: { city: "Graz" } });
    writer.finish("tool_use", { input_tokens: 5, output_tokens: 5 });

    const start = frames.find(
      (f) =>
        f.event === "content_block_start" &&
        (f.data.content_block as Record<string, unknown>).type === "tool_use",
    );
    expect(start!.data.index).toBe(1);
    expect((start!.data.content_block as Record<string, unknown>).name).toBe("get weather");

    const json = frames.find(
      (f) =>
        f.event === "content_block_delta" &&
        (f.data.delta as Record<string, unknown>).type === "input_json_delta",
    );
    expect((json!.data.delta as Record<string, unknown>).partial_json).toBe('{"city":"Graz"}');
    expect(frames.at(-1)!.event).toBe("message_stop");
  });

  test("reports errors as an error frame", () => {
    const { writer, frames } = capture();
    writer.start("msg_4", "claude-sonnet-5");
    writer.error(Object.assign(new Error("nope"), { kind: "api_error", status: 502 }) as never);
    expect(frames.at(-1)!.event).toBe("error");
  });
});
