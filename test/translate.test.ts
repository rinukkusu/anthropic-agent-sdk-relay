import { describe, expect, test } from "bun:test";
import type { AnthropicMessage } from "../src/relay/anthropic.ts";
import {
  pendingToolResults,
  seedPrompt,
  toolResultText,
} from "../src/relay/translate.ts";

const conversation: AnthropicMessage[] = [
  { role: "user", content: "What is the capital of Austria?" },
  { role: "assistant", content: [{ type: "text", text: "Vienna." }] },
  { role: "user", content: "And its population?" },
];

const texts = (content: Array<Record<string, unknown>>) => content.map((block) => block.text);

describe("seedPrompt", () => {
  test("renders one block per message after a fixed preamble", () => {
    const { content } = seedPrompt(conversation);
    expect(content).toHaveLength(4);
    expect(texts(content).slice(1)).toEqual([
      "Human: What is the capital of Austria?",
      "Assistant: Vienna.",
      "Human: And its population?",
    ]);
  });

  test("puts a single cache breakpoint on the current turn", () => {
    const { content } = seedPrompt(conversation);
    const marked = content.filter((block) => block.cache_control);
    expect(marked).toEqual([content[content.length - 1]!]);
  });

  test("is append-only, so the next turn shares the previous one as a prefix", () => {
    const next = seedPrompt([
      ...conversation,
      { role: "assistant", content: "About two million." },
      { role: "user", content: "Thanks" },
    ]).content;
    const previous = seedPrompt(conversation).content;
    const strip = ({ cache_control: _, ...block }: Record<string, unknown>) => block;
    expect(next.slice(0, previous.length).map(strip)).toEqual(previous.map(strip));
  });

  test("sends a first turn as it came", () => {
    const { content } = seedPrompt([{ role: "user", content: "Hello" }]);
    expect(content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("drops cache breakpoints the client sent", () => {
    const { content } = seedPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "a", cache_control: { type: "ephemeral" } },
          { type: "text", text: "b" },
        ],
      },
    ]);
    expect(content.filter((block) => block.cache_control)).toHaveLength(1);
    expect(content[1]!.cache_control).toBeDefined();
  });

  test("preserves image blocks in the current turn", () => {
    const { content } = seedPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
        ],
      },
    ]);
    expect(content).toHaveLength(2);
    expect((content[1] as { type: string }).type).toBe("image");
  });

  test("never produces an empty prompt", () => {
    const { content } = seedPrompt([{ role: "assistant", content: "..." }]);
    expect(content.length).toBeGreaterThan(0);
  });

  test("renders tool calls and their results as readable text", () => {
    const { content } = seedPrompt([
      { role: "user", content: "Weather in Graz?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Graz" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12C" }],
      },
    ]);
    const text = texts(content).join("\n");
    expect(text).toContain('[called tool get_weather with {"city":"Graz"}]');
    expect(text).toContain("[tool result: 12C]");
  });
});

describe("pendingToolResults", () => {
  test("collects tool results from the final user message", () => {
    const results = pendingToolResults([
      ...conversation,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_9", name: "lookup", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_9", content: "1.9 million" },
          { type: "tool_result", tool_use_id: "toolu_10", content: "x", is_error: true },
        ],
      },
    ]);
    expect(results).toEqual([
      { tool_use_id: "toolu_9", content: "1.9 million", is_error: false },
      { tool_use_id: "toolu_10", content: "x", is_error: true },
    ]);
  });

  test("returns nothing when the last message is a plain prompt", () => {
    expect(pendingToolResults(conversation)).toEqual([]);
  });
});

describe("toolResultText", () => {
  test("flattens the shapes clients actually send", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(toolResultText({ ok: true })).toBe('{"ok":true}');
    expect(toolResultText(undefined)).toBe("");
  });
});
