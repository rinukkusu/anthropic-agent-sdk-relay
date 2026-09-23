/**
 * Translation between the Anthropic wire format and what the Agent SDK takes.
 */
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
 * A session only lives while a tool call is open, so every new user turn from
 * the client opens a fresh session and replays the history. To keep that replay
 * cheap, the history is rendered append-only: one block per message, rendered
 * the same way whether it is the current turn or an earlier one, with a cache
 * breakpoint after the current turn. The next request then shares every block
 * up to that breakpoint and reads it from the prompt cache instead of writing
 * the whole conversation again.
 */
export function seedPrompt(
  messages: AnthropicMessage[],
  ttl: "5m" | "1h" = "1h",
): SeededPrompt {
  const last = messages[messages.length - 1];
  const isCurrentUserTurn = last?.role === "user";
  const history = isCurrentUserTurn ? messages.slice(0, -1) : messages;
  const images = isCurrentUserTurn && last
    ? blocksOf(last).filter((block) => block.type === "image")
    : [];

  let content: AnyBlock[];
  if (history.length === 0 && isCurrentUserTurn && last) {
    // A first turn is sent as it came, there is nothing to share with later turns yet.
    content = blocksOf(last).flatMap((block): AnyBlock[] => {
      if (block.type === "text" || block.type === "image") return [block];
      const rendered = renderBlock(block);
      return rendered ? [{ type: "text", text: rendered }] : [];
    });
  } else {
    const rendered = messages
      .map(renderMessage)
      .filter((block): block is AnyBlock => block !== null);
    content = rendered.length ? [{ type: "text", text: HISTORY_PREAMBLE }, ...rendered, ...images] : [];
  }

  if (content.length === 0) {
    return { content: [{ type: "text", text: "Continue." }] };
  }
  // Only this one breakpoint is ours: the CLI adds three more, and the API caps a
  // request at four, so any the client sent along are dropped. Its TTL must match
  // the one the CLI uses, or the API rejects a 1h breakpoint after a 5m one.
  content = content.map(({ cache_control: _, ...block }) => block as AnyBlock);
  const tail = content.length - 1;
  content[tail] = { ...content[tail]!, cache_control: { type: "ephemeral", ttl } };
  return { content };
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
