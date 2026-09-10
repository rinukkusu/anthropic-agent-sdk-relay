import { describe, expect, test } from "bun:test";
import { buildToolBridge, sanitizeToolName } from "../src/relay/bridge.ts";

describe("sanitizeToolName", () => {
  test("replaces characters MCP tool names cannot carry", () => {
    expect(sanitizeToolName("Google Sheets.read")).toBe("Google_Sheets_read");
    expect(sanitizeToolName("plain_name")).toBe("plain_name");
    expect(sanitizeToolName("!!!")).toBe("___");
    expect(sanitizeToolName("")).toBe("tool");
    expect(sanitizeToolName("x".repeat(120))).toHaveLength(60);
  });
});

describe("buildToolBridge", () => {
  const noop = async () => ({ content: [{ type: "text" as const, text: "" }] });

  test("maps the model-facing name back to the client's name", () => {
    const bridge = buildToolBridge(
      [{ name: "Google Sheets.read", description: "read a sheet" }],
      noop,
      1000,
    );
    expect(bridge.allowedTools).toEqual(["mcp__relay__Google_Sheets_read"]);
    expect(bridge.toClientName("mcp__relay__Google_Sheets_read")).toBe("Google Sheets.read");
    expect(bridge.toClientName("mcp__relay__something_else")).toBeUndefined();
  });

  test("keeps names distinct when sanitising collides", () => {
    const bridge = buildToolBridge(
      [{ name: "a.b" }, { name: "a b" }],
      noop,
      1000,
    );
    expect(new Set(bridge.allowedTools).size).toBe(2);
    expect(bridge.toClientName(bridge.allowedTools[0]!)).toBe("a.b");
    expect(bridge.toClientName(bridge.allowedTools[1]!)).toBe("a b");
  });
});
