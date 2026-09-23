/**
 * Drives the real HTTP handler against a scripted Agent SDK, so the tool bridge
 * can be tested without spending subscription tokens.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { AsyncQueue } from "../src/relay/queue.ts";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** The options and tools the code under test handed to the fake SDK. */
const sdk = {
  options: null as Record<string, any> | null,
  handlers: new Map<string, Handler>(),
  stream: null as AsyncQueue<Record<string, unknown>> | null,
};

function resetSdk(): AsyncQueue<Record<string, unknown>> {
  sdk.options = null;
  sdk.handlers.clear();
  sdk.stream = new AsyncQueue<Record<string, unknown>>();
  return sdk.stream;
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, any> }) => {
    sdk.options = options;
    const iterator = sdk.stream![Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      interrupt: async () => undefined,
    };
  },
  tool: (name: string, description: string, inputSchema: unknown, handler: Handler) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
  createSdkMcpServer: (options: { tools?: Array<{ name: string; handler: Handler }> }) => {
    for (const definition of options.tools ?? []) {
      sdk.handlers.set(definition.name, definition.handler);
    }
    return { type: "sdk", name: "relay" };
  },
}));

let handleMessages: typeof import("../src/routes/messages.ts").handleMessages;
let SessionStore: typeof import("../src/relay/session.ts").SessionStore;

beforeAll(async () => {
  ({ handleMessages } = await import("../src/routes/messages.ts"));
  ({ SessionStore } = await import("../src/relay/session.ts"));
});

const config: Config = {
  port: 0,
  host: "127.0.0.1",
  apiKey: null,
  models: { "claude-sonnet-5": { model: "claude-sonnet-5", tools: [] } },
  defaultModel: "claude-sonnet-5",
  sessionTtlMs: 60_000,
  maxSessions: 8,
  toolTimeoutMs: 60_000,
  cwd: process.cwd(),
  logLevel: "error",
  cacheTtl: "1h",
};

function post(body: unknown): Request {
  return new Request("http://relay.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function assistant(content: unknown[]): Record<string, unknown> {
  return { type: "assistant", parent_tool_use_id: null, message: { content } };
}

/** The end of one model message, which may have spanned several assistant messages. */
const messageStop = {
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "message_stop" },
};

function result(text: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    parent_tool_use_id: null,
    stop_reason: "end_turn",
    result: text,
    usage: { input_tokens: 12, output_tokens: 7 },
  };
}

const weatherTool = {
  name: "get weather",
  description: "Weather by city",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

describe("POST /v1/messages", () => {
  test("answers a plain prompt and closes the session", async () => {
    const stream = resetSdk();
    const store = new SessionStore(config);

    const pending = handleMessages(
      post({ model: "claude-sonnet-5", messages: [{ role: "user", content: "Hi" }] }),
      { config, store },
    );

    await Bun.sleep(5);
    stream.push(assistant([{ type: "text", text: "Hello there." }]));
    stream.push(result("Hello there."));

    const body = (await (await pending).json()) as Record<string, any>;
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content).toEqual([{ type: "text", text: "Hello there." }]);
    expect(body.usage).toMatchObject({ input_tokens: 12, output_tokens: 7 });
    // Nothing is parked, so the session must not linger.
    expect(store.size).toBe(0);
  });

  test("passes the client system prompt through and loads no local settings", async () => {
    const stream = resetSdk();
    const store = new SessionStore(config);
    const pending = handleMessages(
      post({
        model: "claude-sonnet-5",
        system: "You are terse.",
        messages: [{ role: "user", content: "Hi" }],
      }),
      { config, store },
    );

    await Bun.sleep(5);
    stream.push(assistant([{ type: "text", text: "ok" }]));
    stream.push(result("ok"));
    await pending;

    expect(sdk.options!.systemPrompt).toBe("You are terse.");
    expect(sdk.options!.settingSources).toEqual([]);
    expect(sdk.options!.tools).toEqual([]);
    expect(sdk.options!.permissionMode).toBe("dontAsk");
  });

  test("bridges a tool call out to the client and resumes on the result", async () => {
    const stream = resetSdk();
    const store = new SessionStore(config);
    const messages = [
      { role: "user" as const, content: "Weather in Graz? Use the tool." },
    ];

    const firstPending = handleMessages(
      post({ model: "claude-sonnet-5", tools: [weatherTool], messages }),
      { config, store },
    );

    await Bun.sleep(5);
    // The SDK announces the call, then invokes the in-process MCP tool.
    stream.push(
      assistant([
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "mcp__relay__get_weather",
          input: { city: "Graz" },
        },
      ]),
    );
    stream.push(messageStop);
    await Bun.sleep(5);
    const toolPromise = sdk.handlers.get("get_weather")!({ city: "Graz" });

    const first = (await (await firstPending).json()) as Record<string, any>;
    expect(first.stop_reason).toBe("tool_use");
    expect(first.content).toEqual([
      { type: "text", text: "Checking." },
      // The client sees its own tool name, not the MCP-qualified one.
      { type: "tool_use", id: "toolu_abc", name: "get weather", input: { city: "Graz" } },
    ]);
    // The session stays alive because a call is outstanding.
    expect(store.size).toBe(1);

    const secondPending = handleMessages(
      post({
        model: "claude-sonnet-5",
        tools: [weatherTool],
        messages: [
          ...messages,
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_abc", content: "Snow, -4C" },
            ],
          },
        ],
      }),
      { config, store },
    );

    // The parked MCP call now completes with what the client returned.
    expect(await toolPromise).toEqual({
      content: [{ type: "text", text: "Snow, -4C" }],
      isError: false,
    });

    await Bun.sleep(5);
    stream.push(assistant([{ type: "text", text: "It is snowing in Graz, -4C." }]));
    stream.push(result("It is snowing in Graz, -4C."));

    const second = (await (await secondPending).json()) as Record<string, any>;
    expect(second.stop_reason).toBe("end_turn");
    expect(second.content[0].text).toContain("snowing");
    expect(store.size).toBe(0);
  });

  test("resolves a tool call whose MCP invocation arrives before the announcement", async () => {
    const stream = resetSdk();
    const store = new SessionStore(config);
    const pending = handleMessages(
      post({
        model: "claude-sonnet-5",
        tools: [weatherTool],
        messages: [{ role: "user", content: "Weather?" }],
      }),
      { config, store },
    );

    await Bun.sleep(5);
    // Race: the MCP channel fires first, the assistant message lands after.
    const toolPromise = sdk.handlers.get("get_weather")!({ city: "Linz" });
    await Bun.sleep(5);
    stream.push(
      assistant([
        { type: "tool_use", id: "toolu_race", name: "mcp__relay__get_weather", input: { city: "Linz" } },
      ]),
    );
    stream.push(messageStop);

    const first = (await (await pending).json()) as Record<string, any>;
    expect(first.stop_reason).toBe("tool_use");

    void handleMessages(
      post({
        model: "claude-sonnet-5",
        tools: [weatherTool],
        messages: [
          { role: "user", content: "Weather?" },
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_race", content: "Sunny" }],
          },
        ],
      }),
      { config, store },
    );

    expect(await toolPromise).toEqual({
      content: [{ type: "text", text: "Sunny" }],
      isError: false,
    });
  });

  test("hands out parallel tool calls together and resumes on both results", async () => {
    const stream = resetSdk();
    const store = new SessionStore(config);
    const messages = [{ role: "user" as const, content: "Weather in Graz and Linz?" }];
    const pending = handleMessages(
      post({ model: "claude-sonnet-5", tools: [weatherTool], messages }),
      { config, store },
    );

    await Bun.sleep(5);
    // The SDK reports each block as its own assistant message and starts the
    // first tool before the model's message has ended.
    stream.push(
      assistant([
        { type: "tool_use", id: "toolu_1", name: "mcp__relay__get_weather", input: { city: "Graz" } },
      ]),
    );
    const graz = sdk.handlers.get("get_weather")!({ city: "Graz" });
    await Bun.sleep(5);
    stream.push(
      assistant([
        { type: "tool_use", id: "toolu_2", name: "mcp__relay__get_weather", input: { city: "Linz" } },
      ]),
    );
    stream.push(messageStop);

    const first = (await (await pending).json()) as Record<string, any>;
    expect(first.stop_reason).toBe("tool_use");
    expect(first.content.map((block: { id: string }) => block.id)).toEqual(["toolu_1", "toolu_2"]);

    void handleMessages(
      post({
        model: "claude-sonnet-5",
        tools: [weatherTool],
        messages: [
          ...messages,
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "Snow" },
              { type: "tool_result", tool_use_id: "toolu_2", content: "Sun" },
            ],
          },
        ],
      }),
      { config, store },
    );

    expect(await graz).toEqual({ content: [{ type: "text", text: "Snow" }], isError: false });
    // The CLI runs the second tool only after the first returns; its result is
    // already waiting by then.
    expect(await sdk.handlers.get("get_weather")!({ city: "Linz" })).toEqual({
      content: [{ type: "text", text: "Sun" }],
      isError: false,
    });
  });

  test("streams deltas and writes the tool call at the end", async () => {
    const stream = resetSdk();
    const store = new SessionStore(config);
    const pending = handleMessages(
      post({
        model: "claude-sonnet-5",
        stream: true,
        tools: [weatherTool],
        messages: [{ role: "user", content: "Weather in Graz?" }],
      }),
      { config, store },
    );

    const response = await pending;
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    await Bun.sleep(5);
    for (const text of ["Check", "ing."]) {
      stream.push({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      });
    }
    await Bun.sleep(5);
    stream.push(
      assistant([
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_s", name: "mcp__relay__get_weather", input: { city: "Graz" } },
      ]),
    );
    stream.push(messageStop);

    const body = await response.text();
    const events = [...body.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    expect(events[0]).toBe("message_start");
    expect(events.at(-1)).toBe("message_stop");
    expect(body).toContain('"text_delta","text":"Check"');
    expect(body).toContain('"name":"get weather"');
    expect(body).toContain('"stop_reason":"tool_use"');
  });

  test("reports an SDK authentication failure as a 401", async () => {
    const stream = resetSdk();
    const store = new SessionStore(config);
    const pending = handleMessages(
      post({ model: "claude-sonnet-5", messages: [{ role: "user", content: "Hi" }] }),
      { config, store },
    );

    await Bun.sleep(5);
    stream.push({
      type: "assistant",
      parent_tool_use_id: null,
      error: "authentication_failed",
      message: { content: [] },
    });

    const response = await pending;
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.type).toBe("authentication_error");
    expect(store.size).toBe(0);
  });

  test("rejects a malformed body without opening a session", async () => {
    resetSdk();
    const store = new SessionStore(config);
    const response = await handleMessages(post({ messages: [] }), { config, store });
    expect(response.status).toBe(400);
    expect(store.size).toBe(0);
  });
});
