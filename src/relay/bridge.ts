/**
 * Bridging client-declared tools into the Agent SDK.
 *
 * Each tool the client declares becomes an in-process MCP tool. Its handler does
 * not compute anything: it hands the call to the session, which parks it and
 * ends the HTTP turn with a `tool_use` block. The promise resolves later, when
 * the client posts the matching `tool_result` back.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { AnthropicTool } from "./anthropic.ts";
import { jsonSchemaToShape } from "./schema.ts";

/** The MCP server name; the model sees tools as `mcp__<SERVER_NAME>__<tool>`. */
export const SERVER_NAME = "relay";

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type BridgeHandler = (
  clientName: string,
  input: Record<string, unknown>,
) => Promise<ToolCallResult>;

export type ToolBridge = {
  serverName: string;
  server: ReturnType<typeof createSdkMcpServer>;
  /** Every tool name the model may call, fully qualified. */
  allowedTools: string[];
  /** Model-facing name back to the name the client used. */
  toClientName(modelName: string): string | undefined;
};

/**
 * MCP tool names are restricted to word characters and dashes. Client tool names
 * are not, so they are sanitised and mapped back on the way out.
 */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  return cleaned || "tool";
}

export function buildToolBridge(
  tools: AnthropicTool[],
  handler: BridgeHandler,
  timeoutMs: number,
): ToolBridge {
  const toClient = new Map<string, string>();
  const used = new Set<string>();

  const definitions = tools.map((definition) => {
    let safe = sanitizeToolName(definition.name);
    let suffix = 2;
    while (used.has(safe)) safe = `${sanitizeToolName(definition.name)}_${suffix++}`;
    used.add(safe);
    toClient.set(`mcp__${SERVER_NAME}__${safe}`, definition.name);
    toClient.set(safe, definition.name);

    return tool(
      safe,
      definition.description ?? `Tool ${definition.name}`,
      jsonSchemaToShape(definition.input_schema),
      async (args) => handler(definition.name, (args ?? {}) as Record<string, unknown>),
    );
  });

  return {
    serverName: SERVER_NAME,
    server: createSdkMcpServer({
      name: SERVER_NAME,
      version: "1.0.0",
      tools: definitions,
      alwaysLoad: true,
      timeout: timeoutMs,
    }),
    allowedTools: [...used].map((name) => `mcp__${SERVER_NAME}__${name}`),
    toClientName: (modelName: string) => toClient.get(modelName),
  };
}
