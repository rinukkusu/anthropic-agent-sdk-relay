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

export type SeededPrompt = {
  /** Content blocks for the SDK user message that opens the session. */
  content: AnyBlock[];
};

const HISTORY_PREAMBLE =
  "The conversation so far follows, one message per block. Reply to the last Human " +
  "message as the Assistant, and do not mention this framing.";

function renderMessage(message: AnthropicMessage): AnyBlock | null {
  const rendered = blocksOf(message)
    .map(renderBlock)
    .filter((line) => line.trim() !== "")
    .join("\n");
  if (!rendered) return null;
  return { type: "text", text: `${message.role === "user" ? "Human" : "Assistant"}: ${rendered}` };
}

/**
 * Build the opening user message for a new session.
 *
 * A session carries on across the client's turns while the history matches, so
 * a replay is the exception: the start of a conversation, or a history the
 * client rewrote or the relay no longer holds. It is rendered one block per
 * message, the same way for every turn.
 *
 * The message carries no cache breakpoint of ours. The CLI marks two blocks of
 * the system prompt and the last two messages of every request, the API refuses
 * a fifth, and a block in the opening message stays in every later request of
 * the session. Breakpoints the client sent along are dropped for the same reason.
 */
export function seedPrompt(messages: AnthropicMessage[]): SeededPrompt {
  const last = messages[messages.length - 1];
  const isCurrentUserTurn = last?.role === "user";
  const history = isCurrentUserTurn ? messages.slice(0, -1) : messages;
  const images = isCurrentUserTurn && last
    ? blocksOf(last).filter((block) => block.type === "image")
    : [];

  let content: AnyBlock[];
  if (history.length === 0 && isCurrentUserTurn && last) {
    content = asSent(last);
  } else {
    const rendered = messages
      .map(renderMessage)
      .filter((block): block is AnyBlock => block !== null);
    content = rendered.length ? [{ type: "text", text: HISTORY_PREAMBLE }, ...rendered, ...images] : [];
  }

  if (content.length === 0) {
    return { content: [{ type: "text", text: "Continue." }] };
  }
  return { content: content.map(({ cache_control: _, ...block }) => block as AnyBlock) };
}

/** A message's text and images as they came, anything else rendered to text. */
function asSent(message: AnthropicMessage): AnyBlock[] {
  return blocksOf(message).flatMap((block): AnyBlock[] => {
    if (block.type === "text" || block.type === "image") {
      const { cache_control: _, ...rest } = block;
      return [rest as AnyBlock];
    }
    const rendered = renderBlock(block);
    return rendered ? [{ type: "text", text: rendered }] : [];
  });
}

/**
 * The content to append to a live session that already holds the rest of the
 * conversation. The CLI marks the newest message for the cache itself.
 */
export function continuationContent(message: AnthropicMessage): AnyBlock[] {
  const content = asSent(message);
  return content.length ? content : [{ type: "text", text: "Continue." }];
}

/**
 * Identifies a conversation at a given point, so a later request can be matched
 * to the live session that is already there. It covers everything a running
 * session cannot change (passed in as `context`) and the history rendered the
 * way the replay renders it, which leaves out thinking blocks, tool ids and
 * cache markers that clients drop or move between requests.
 */
export function conversationKey(context: unknown, messages: AnthropicMessage[]): string {
  const hash = createHash("sha256").update(JSON.stringify(context));
  for (const message of messages) {
    const rendered = renderMessage(message);
    if (rendered) hash.update(`\n${JSON.stringify(String(rendered.text).trim())}`);
  }
  return hash.digest("hex");
}

/**
 * Collect the tool_result blocks that follow the last assistant message, in order.
 * Clients that run their own tool loop often send one user message per result of
 * a parallel batch; the API merges consecutive user messages, so the relay must too.
 */
export function pendingToolResults(
  messages: AnthropicMessage[],
): Array<{ tool_use_id: string; content: unknown; is_error: boolean }> {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role === "user") start -= 1;
  return messages
    .slice(start)
    .flatMap(blocksOf)
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
