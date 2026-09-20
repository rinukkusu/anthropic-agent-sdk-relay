/**
 * Translation between the Anthropic wire format and what the Agent SDK takes.
 */
import { createHash } from "node:crypto";
import type { AnthropicMessage, ContentBlock, Usage } from "./anthropic.ts";

type AnyBlock = Record<string, unknown> & { type: string };

function blocksOf(message: AnthropicMessage): AnyBlock[] {
  if (typeof message.content === "string") {
    return message.content ? [{ type: "text", text: message.content }] : [];
  }
  return message.content as AnyBlock[];
}

/** Flatten a tool_result's content, which may be a string or a block array. */
export function toolResultText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as AnyBlock;
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (b.type === "image") return "[image]";
        }
        return JSON.stringify(block);
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function renderBlock(block: AnyBlock): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "tool_use":
      return `[called tool ${String(block.name)} with ${JSON.stringify(block.input ?? {})}]`;
    case "tool_result": {
      const body = toolResultText(block.content);
      const failed = block.is_error ? " (error)" : "";
      return `[tool result${failed}: ${body}]`;
    }
    case "image":
      return "[image]";
    case "thinking":
      return "";
    default:
      return "";
  }
}

/**
 * Render the turns before the current one as a transcript.
 *
 * A fresh Agent SDK session cannot have assistant turns injected into it, so
 * earlier exchanges are replayed to the model as text. This only ever runs when
 * a session is being opened; continuations ride the live session and keep their
 * real context.
 */
export function renderTranscript(messages: AnthropicMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const rendered = blocksOf(message)
      .map(renderBlock)
      .filter((line) => line.trim() !== "")
      .join("\n");
    if (!rendered) continue;
    lines.push(`${message.role === "user" ? "Human" : "Assistant"}: ${rendered}`);
  }
  return lines.join("\n\n");
}

export type SeededPrompt = {
  /** Content blocks for the SDK user message that opens the session. */
  content: AnyBlock[];
};

/** The blocks of a single user turn, as the SDK can take them. */
export function userTurnContent(message: AnthropicMessage): AnyBlock[] {
  const content: AnyBlock[] = [];
  for (const block of blocksOf(message)) {
    if (block.type === "text" || block.type === "image") {
      content.push(block);
    } else {
      const rendered = renderBlock(block);
      if (rendered) content.push({ type: "text", text: rendered });
    }
  }
  return content;
}

/**
 * The transcript is wrapped in a constant prefix and a constant suffix, and the
 * current turn is rendered *inside* it rather than appended after it. That keeps
 * the prompt strictly append-only across turns: everything up to the end of the
 * previous turn is byte-identical, which is the only shape a cached prefix can
 * be reused from when a session has to be opened cold.
 */
const TRANSCRIPT_PREFIX =
  "Here is the conversation so far. Continue it naturally; do not mention this transcript.\n\n" +
  "<conversation_history>\n";
const TRANSCRIPT_SUFFIX = "\n</conversation_history>\n\nReply to the final Human turn above.";

/** Image blocks of the final user turn, which the transcript can only name. */
function trailingImages(messages: AnthropicMessage[]): AnyBlock[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return [];
  return blocksOf(last).filter((block) => block.type === "image");
}

/**
 * Build the opening user message for a new session.
 *
 * A lone user turn is passed through untouched; anything longer is replayed as
 * an append-only transcript.
 */
export function seedPrompt(messages: AnthropicMessage[]): SeededPrompt {
  const only = messages.length === 1 ? messages[0] : undefined;
  if (only?.role === "user") {
    const content = userTurnContent(only);
    return { content: content.length ? content : [{ type: "text", text: "Continue." }] };
  }

  const content: AnyBlock[] = [];
  const transcript = renderTranscript(messages);
  if (transcript) {
    content.push({ type: "text", text: TRANSCRIPT_PREFIX + transcript + TRANSCRIPT_SUFFIX });
  }
  content.push(...trailingImages(messages));

  if (content.length === 0) {
    content.push({ type: "text", text: "Continue." });
  }
  return { content };
}

/**
 * Fingerprint the conversation a session has consumed.
 *
 * The Messages API is stateless and clients do not carry a relay session id, so
 * the history itself is the continuation key: a request whose earlier turns
 * match what a live session was fed is that session's next turn.
 */
export function conversationKey(
  model: string | undefined,
  system: string | undefined,
  messages: AnthropicMessage[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([model ?? "", system ?? "", messages]))
    .digest("hex");
}

/**
 * The key a live session would carry if this request continues it.
 *
 * Trailing assistant turns are dropped: the client appends the relay's own
 * reply, which the session never received as input and never fingerprinted.
 */
export function continuationKey(
  model: string | undefined,
  system: string | undefined,
  messages: AnthropicMessage[],
): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  let end = messages.length - 1;
  while (end > 0 && messages[end - 1]!.role === "assistant") end -= 1;
  if (end === 0) return null;
  return conversationKey(model, system, messages.slice(0, end));
}

/** Collect the tool_result blocks in the final user message, in order. */
export function pendingToolResults(
  messages: AnthropicMessage[],
): Array<{ tool_use_id: string; content: unknown; is_error: boolean }> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return [];
  return blocksOf(last)
    .filter((block) => block.type === "tool_result")
    .map((block) => ({
      tool_use_id: String(block.tool_use_id),
      content: block.content,
      is_error: block.is_error === true,
    }));
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0 };
}

/** Pull usage out of an Agent SDK result message, tolerating missing fields. */
export function usageFromResult(usage: unknown): Usage {
  if (!usage || typeof usage !== "object") return emptyUsage();
  const u = usage as Record<string, unknown>;
  const int = (value: unknown) => (typeof value === "number" ? value : 0);
  return {
    input_tokens: int(u.input_tokens),
    output_tokens: int(u.output_tokens),
    cache_read_input_tokens: int(u.cache_read_input_tokens),
    cache_creation_input_tokens: int(u.cache_creation_input_tokens),
  };
}

export type { ContentBlock };
