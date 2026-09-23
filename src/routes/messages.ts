/** POST /v1/messages */
import { resolveModel, type Config } from "../config.ts";
import {
  errorResponse,
  messagesRequestSchema,
  systemToString,
  type MessagesResponse,
  type OutBlock,
  type Usage,
} from "../relay/anthropic.ts";
import { buildToolBridge } from "../relay/bridge.ts";
import {
  RelayError,
  Session,
  SessionStore,
  type StreamEvent,
  type TurnOutcome,
} from "../relay/session.ts";
import { pendingToolResults, seedPrompt, toolResultText } from "../relay/translate.ts";

export type RouteContext = { config: Config; store: SessionStore };

function messageId(): string {
  return `msg_relay_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Decide how this request joins the relay's state: resume the session waiting on
 * these tool results, or open a new one.
 */
function prepareTurn(
  body: ReturnType<typeof messagesRequestSchema.parse>,
  ctx: RouteContext,
): { session: Session; run: (onEvent?: (e: StreamEvent) => void) => Promise<TurnOutcome> } {
  const results = pendingToolResults(body.messages);
  const existing = results.length
    ? ctx.store.find(results.map((result) => result.tool_use_id))
    : undefined;

  if (existing) {
    const payload = results.map((result) => ({
      tool_use_id: result.tool_use_id,
      content: toolResultText(result.content),
      is_error: result.is_error,
    }));
    return { session: existing, run: (onEvent) => existing.resume(payload, onEvent) };
  }

  const alias = resolveModel(ctx.config, body.model);
  let session!: Session;
  const declared = body.tools ?? [];
  const bridge = declared.length
    ? buildToolBridge(
        declared,
        (name, input) => session.handleToolCall(name, input),
        ctx.config.toolTimeoutMs,
      )
    : null;

  session = new Session({
    config: ctx.config,
    alias,
    systemPrompt: systemToString(body.system),
    tools: bridge,
  });
  ctx.store.add(session);

  const { content } = seedPrompt(body.messages);
  return { session, run: (onEvent) => session.start(content, onEvent) };
}

/** Failed turns are logged at every level; the client may not show the error. */
function logFailure(model: string, error: RelayError): void {
  console.error(`turn ${model} failed (${error.status} ${error.kind}): ${error.message}`);
}

/** One line per finished turn, so cache behaviour is visible in the logs. */
function logTurn(ctx: RouteContext, model: string, outcome: TurnOutcome): void {
  if (ctx.config.logLevel === "error") return;
  const u = outcome.usage;
  console.log(
    `turn ${model} ${outcome.stop_reason}: input=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} output=${u.output_tokens}`,
  );
}

function toResponse(model: string, outcome: TurnOutcome): MessagesResponse {
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content: outcome.content,
    stop_reason: outcome.stop_reason,
    stop_sequence: null,
    usage: outcome.usage,
  };
}

/** Writes an Anthropic-shaped SSE stream, re-indexing blocks as they are produced. */
export class SseWriter {
  private index = 0;
  private open: "text" | "thinking" | null = null;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly encoder = new TextEncoder(),
  ) {}

  private send(event: string, data: unknown): void {
    this.controller.enqueue(
      this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }

  start(id: string, model: string): void {
    this.send("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  delta(event: StreamEvent): void {
    if (this.open !== event.type) {
      this.closeBlock();
      this.send("content_block_start", {
        type: "content_block_start",
        index: this.index,
        content_block:
          event.type === "text"
            ? { type: "text", text: "" }
            : { type: "thinking", thinking: "" },
      });
      this.open = event.type;
    }
    this.send("content_block_delta", {
      type: "content_block_delta",
      index: this.index,
      delta:
        event.type === "text"
          ? { type: "text_delta", text: event.text }
          : { type: "thinking_delta", thinking: event.text },
    });
  }

  private closeBlock(): void {
    if (this.open === null) return;
    this.send("content_block_stop", { type: "content_block_stop", index: this.index });
    this.open = null;
    this.index += 1;
  }

  toolUse(block: Extract<OutBlock, { type: "tool_use" }>): void {
    this.closeBlock();
    this.send("content_block_start", {
      type: "content_block_start",
      index: this.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    this.send("content_block_delta", {
      type: "content_block_delta",
      index: this.index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    });
    this.send("content_block_stop", { type: "content_block_stop", index: this.index });
    this.index += 1;
  }

  finish(stop_reason: string, usage: Usage): void {
    this.closeBlock();
    this.send("message_delta", {
      type: "message_delta",
      delta: { stop_reason, stop_sequence: null },
      usage,
    });
    this.send("message_stop", { type: "message_stop" });
  }

  error(error: RelayError): void {
    this.send("error", {
      type: "error",
      error: { type: error.kind, message: error.message },
    });
  }
}

export async function handleMessages(request: Request, ctx: RouteContext): Promise<Response> {
  let body: ReturnType<typeof messagesRequestSchema.parse>;
  try {
    body = messagesRequestSchema.parse(await request.json());
  } catch (error) {
    return errorResponse(400, "invalid_request_error", `Malformed request: ${String(error)}`);
  }

  const model = body.model ?? ctx.config.defaultModel;
  let turn: ReturnType<typeof prepareTurn>;
  try {
    turn = prepareTurn(body, ctx);
  } catch (error) {
    return errorResponse(500, "api_error", `Could not start a session: ${String(error)}`);
  }

  if (!body.stream) {
    try {
      const outcome = await turn.run();
      ctx.store.settle(turn.session);
      logTurn(ctx, model, outcome);
      return Response.json(toResponse(model, outcome));
    } catch (error) {
      turn.session.close();
      const relay = error instanceof RelayError ? error : new RelayError(String(error));
      logFailure(model, relay);
      return errorResponse(relay.status, relay.kind, relay.message);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new SseWriter(controller);
      writer.start(messageId(), model);
      try {
        // Tool-use blocks are held back and written at the end, so the stream
        // carries the renamed client-facing tool rather than the MCP one.
        const outcome = await turn.run((event) => writer.delta(event));
        ctx.store.settle(turn.session);
        logTurn(ctx, model, outcome);
        for (const block of outcome.content) {
          if (block.type === "tool_use") writer.toolUse(block);
        }
        writer.finish(outcome.stop_reason, outcome.usage);
      } catch (error) {
        turn.session.close();
        const relay = error instanceof RelayError ? error : new RelayError(String(error));
        logFailure(model, relay);
        writer.error(relay);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
