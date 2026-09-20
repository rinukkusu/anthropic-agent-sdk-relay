import { describe, expect, test } from "bun:test";
import type { AnthropicMessage } from "../src/relay/anthropic.ts";
import {
  continuationKey,
  conversationKey,
  pendingToolResults,
  renderTranscript,
  seedPrompt,
  toolResultText,
} from "../src/relay/translate.ts";

const conversation: AnthropicMessage[] = [
  { role: "user", content: "What is the capital of Austria?" },
  { role: "assistant", content: [{ type: "text", text: "Vienna." }] },
  { role: "user", content: "And its population?" },
];

describe("seedPrompt", () => {
  test("renders the whole conversation, current turn included, as one transcript", () => {
    const { content } = seedPrompt(conversation);
    expect(content).toHaveLength(1);
    const transcript = content[0] as unknown as { text: string };
    expect(transcript.text).toContain("Human: What is the capital of Austria?");
    expect(transcript.text).toContain("Assistant: Vienna.");
    expect(transcript.text).toContain("Human: And its population?");
  });

  test("grows append-only, so a cold restart still shares a prefix", () => {
    const earlier = seedPrompt(conversation.slice(0, 2));
    const later = seedPrompt(conversation);
    const a = (earlier.content[0] as unknown as { text: string }).text;
    const b = (later.content[0] as unknown as { text: string }).text;
    // Everything up to the end of the previous turn is byte-identical.
    const shared = a.slice(0, a.indexOf("\n</conversation_history>"));
    expect(b.startsWith(shared)).toBe(true);
  });

  test("skips the transcript entirely for a first turn", () => {
    const { content } = seedPrompt([{ role: "user", content: "Hello" }]);
    expect(content).toEqual([{ type: "text", text: "Hello" }]);
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
});

describe("renderTranscript", () => {
  test("renders tool calls and their results as readable text", () => {
    const text = renderTranscript([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Graz" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12C" }],
      },
    ]);
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

describe("conversation keys", () => {
  test("a follow-up turn keys onto what the previous request was fed", () => {
    const first: AnthropicMessage[] = [conversation[0]!];
    const stored = conversationKey("claude-sonnet-5", undefined, first);
    expect(continuationKey("claude-sonnet-5", undefined, conversation)).toBe(stored);
  });

  test("the key covers the model and the system prompt", () => {
    const a = conversationKey("claude-sonnet-5", "terse", conversation);
    expect(conversationKey("claude-opus-5", "terse", conversation)).not.toBe(a);
    expect(conversationKey("claude-sonnet-5", "verbose", conversation)).not.toBe(a);
  });

  test("a first turn has nothing to continue", () => {
    expect(continuationKey("claude-sonnet-5", undefined, [conversation[0]!])).toBeNull();
  });

  test("a trailing assistant turn is not a continuation", () => {
    expect(
      continuationKey("claude-sonnet-5", undefined, conversation.slice(0, 2)),
    ).toBeNull();
  });
});
