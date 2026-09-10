/**
 * The slice of the Anthropic Messages API the relay accepts, and the response
 * shapes it produces.
 */
import { z } from "zod";

const imageSource = z.union([
  z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
  z.object({ type: z.literal("url"), url: z.string() }),
]);

const textBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const imageBlock = z.object({
  type: z.literal("image"),
  source: imageSource,
});

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown().default({}),
});

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const thinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string().default(""),
  signature: z.string().optional(),
});

/** Blocks the relay understands; anything else is carried as an opaque passthrough. */
const contentBlock = z.union([
  textBlock,
  imageBlock,
  toolUseBlock,
  toolResultBlock,
  thinkingBlock,
  z.object({ type: z.string() }).passthrough(),
]);

export const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(contentBlock)]),
});

export const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

export const messagesRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  system: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]).optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.unknown().optional(),
  metadata: z.unknown().optional(),
  thinking: z.unknown().optional(),
});

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;
export type AnthropicMessage = z.infer<typeof messageSchema>;
export type AnthropicTool = z.infer<typeof toolSchema>;
export type ContentBlock = z.infer<typeof contentBlock>;

export type OutBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type MessagesResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: OutBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  stop_sequence: null;
  usage: Usage;
};

/** Flatten the `system` field into the single string the Agent SDK takes. */
export function systemToString(system: MessagesRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system.trim() || undefined;
  const text = system
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return text.trim() || undefined;
}

export function errorResponse(status: number, type: string, message: string): Response {
  return Response.json(
    { type: "error", error: { type, message } },
    { status, headers: { "content-type": "application/json" } },
  );
}
