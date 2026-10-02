/**
 * Live Agent SDK sessions.
 *
 * A session is opened when a conversation starts and stays open across HTTP
 * requests for as long as a tool call is outstanding. That is what lets the
 * relay hand a `tool_use` block to the client, wait for the `tool_result` to
 * come back over a separate request, and resume the very same agent loop
 * without replaying anything.
 */
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { childEnv, type Config, type ModelAlias } from "../config.ts";
import type { Effort, OutBlock, Thinking, Usage } from "./anthropic.ts";
import { buildToolBridge, type ToolBridge, type ToolCallResult } from "./bridge.ts";
import { AsyncQueue } from "./queue.ts";
import { emptyUsage, usageFromResult } from "./translate.ts";

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string };

export type TurnOutcome = {
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  content: OutBlock[];
  usage: Usage;
};

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly kind: string = "api_error",
  ) {
    super(message);
  }
}

type ParkedCall = {
  id: string;
  clientName: string;
  input: Record<string, unknown>;
  /** Set once the MCP handler has been invoked for this call. */
  resolve?: (result: ToolCallResult) => void;
  /** Set if the client's tool_result arrived before the MCP handler fired. */
  result?: ToolCallResult;
};

type WaitingHandler = {
  clientName: string;
  input: Record<string, unknown>;
  resolve: (result: ToolCallResult) => void;
};

/** Collects one client-visible turn out of the SDK's message stream. */
class Turn {
  readonly content: OutBlock[] = [];
  /** Client tool calls announced so far, handed out once the model's message ends. */
  readonly calls: OutBlock[] = [];
  /** Usage of the API calls made during this turn, read off the stream. */
  private streamed: Usage | null = null;
  private callOutput = 0;
  /** The SDK's own figure, summed over its whole agent loop; only a fallback. */
  private resultUsage: Usage = emptyUsage();
  private settled = false;
  private resolveFn!: (outcome: TurnOutcome) => void;
  private rejectFn!: (error: unknown) => void;
  readonly done: Promise<TurnOutcome>;

  constructor(private readonly onEvent?: (event: StreamEvent) => void) {
    this.done = new Promise<TurnOutcome>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  emit(event: StreamEvent): void {
    if (!this.settled) this.onEvent?.(event);
  }

  addBlock(block: OutBlock): void {
    this.content.push(block);
  }

  /**
   * An API call started. Its input buckets replace the previous call's, so they
   * state the size of the context right now, which is what clients read them as.
   */
  callStarted(usage: Usage): void {
    this.streamed = {
      ...usage,
      output_tokens: (this.streamed?.output_tokens ?? 0) + this.callOutput,
    };
    this.callOutput = 0;
  }

  /** The running output count of the current call; message_delta reports it cumulatively. */
  callOutputSoFar(tokens: number): void {
    this.callOutput = tokens;
  }

  setResultUsage(usage: Usage): void {
    this.resultUsage = usage;
  }

  /**
   * The SDK reports usage once per agent loop, summed over every model call in
   * it, and a loop spans all the tool round trips of a client turn. Handing that
   * sum to the client inflates its idea of the context size with every tool call,
   * which pushes agents such as Hermes into needless context compression. The
   * stream carries each call's own usage, so that is what the client gets.
   */
  private get usage(): Usage {
    if (!this.streamed) return this.resultUsage;
    return {
      ...this.streamed,
      output_tokens: this.streamed.output_tokens + this.callOutput,
    };
  }

  finish(stop_reason: TurnOutcome["stop_reason"], extra: OutBlock[] = []): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn({
      stop_reason,
      content: [...this.content, ...extra],
      usage: this.usage,
    });
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(error);
  }

  get isSettled(): boolean {
    return this.settled;
  }
}

export type SessionOptions = {
  config: Config;
  alias: ModelAlias;
  systemPrompt?: string;
  tools: ToolBridge | null;
  /** Reasoning controls; unset leaves the CLI's defaults. */
  effort?: Effort;
  thinking?: Thinking;
};

export class Session {
  readonly id: string = crypto.randomUUID();
  lastUsed = Date.now();

  private readonly inbox = new AsyncQueue<Record<string, unknown>>();
  private readonly abort = new AbortController();
  private readonly parked = new Map<string, ParkedCall>();
  private readonly waiting: WaitingHandler[] = [];
  private readonly stderr: string[] = [];
  private turn: Turn | null = null;
  private query: Query | null = null;
  private closed = false;
  private onClose: (() => void) | null = null;

  constructor(private readonly options: SessionOptions) {}

  get toolUseIds(): string[] {
    return [...this.parked.keys()];
  }

  get hasParkedCalls(): boolean {
    return this.parked.size > 0;
  }

  setOnClose(fn: () => void): void {
    this.onClose = fn;
  }

  /** Handler invoked by the bridged MCP tools. Never resolves on its own. */
  handleToolCall = (
    clientName: string,
    input: Record<string, unknown>,
  ): Promise<ToolCallResult> => {
    return new Promise<ToolCallResult>((resolve) => {
      // The assistant message announcing this call usually lands first, but the
      // MCP call arrives on its own channel, so either order is possible.
      const announced = [...this.parked.values()].find(
        (call) => call.clientName === clientName && !call.resolve && !call.result,
      );
      if (announced) {
        announced.resolve = resolve;
        return;
      }
      const delivered = [...this.parked.values()].find(
        (call) => call.clientName === clientName && call.result && !call.resolve,
      );
      if (delivered) {
        delivered.resolve = resolve;
        resolve(delivered.result!);
        this.parked.delete(delivered.id);
        return;
      }
      this.waiting.push({ clientName, input, resolve });
    });
  };

  /** Open the SDK query and send the first user message. */
  start(content: unknown[], onEvent?: (event: StreamEvent) => void): Promise<TurnOutcome> {
    const { config, alias, systemPrompt, tools, effort, thinking } = this.options;
    const turn = new Turn(onEvent);
    this.turn = turn;

    this.query = query({
      prompt: this.inbox[Symbol.asyncIterator]() as never,
      options: {
        model: alias.model,
        effort,
        thinking,
        systemPrompt,
        // A relay is not a coding agent: no project settings, no CLAUDE.md, no
        // skills, and no built-in tools unless the model alias asks for them.
        settingSources: [],
        tools: alias.tools,
        allowedTools: [...alias.tools, ...(tools?.allowedTools ?? [])],
        permissionMode: "dontAsk",
        mcpServers: tools ? { [tools.serverName]: tools.server } : undefined,
        // Always on: `message_stop` is the only signal that the model has
        // finished announcing a batch of parallel tool calls.
        includePartialMessages: true,
        persistSession: false,
        // A fixed title skips the CLI's title generation, a second model call
        // per session that would send the whole replayed history uncached.
        title: "anthropic-agent-sdk-relay",
        cwd: config.cwd,
        abortController: this.abort,
        env: childEnv(config),
        stderr: (data: string) => {
          this.stderr.push(data);
          if (this.stderr.length > 50) this.stderr.shift();
        },
      },
    });

    void this.pump();
    this.send(content);
    return turn.done;
  }

  /**
   * Carry on with a session whose last turn ended, by appending the client's new
   * user message. The session still holds the whole conversation, so nothing is
   * replayed and every earlier block stays in the prompt cache as it was.
   */
  continue(content: unknown[], onEvent?: (event: StreamEvent) => void): Promise<TurnOutcome> {
    const turn = new Turn(onEvent);
    this.turn = turn;
    this.lastUsed = Date.now();
    this.send(content);
    return turn.done;
  }

  private send(content: unknown[]): void {
    this.inbox.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
  }

  /**
   * Resolve parked calls with the client's tool results and collect the turn
   * that follows.
   */
  resume(
    results: Array<{ tool_use_id: string; content: string; is_error: boolean }>,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<TurnOutcome> {
    const turn = new Turn(onEvent);
    this.turn = turn;
    this.lastUsed = Date.now();

    for (const result of results) {
      const call = this.parked.get(result.tool_use_id);
      if (!call) continue;
      const payload: ToolCallResult = {
        content: [{ type: "text", text: result.content }],
        isError: result.is_error,
      };
      if (call.resolve) {
        call.resolve(payload);
        this.parked.delete(result.tool_use_id);
      } else {
        call.result = payload;
      }
    }
    return turn.done;
  }

  private async pump(): Promise<void> {
    if (!this.query) return;
    try {
      for await (const message of this.query) {
        this.lastUsed = Date.now();
        this.handle(message as Record<string, unknown>);
      }
      this.turn?.finish("end_turn");
    } catch (error) {
      if (!this.closed) {
        this.turn?.fail(
          new RelayError(
            `Agent SDK session failed: ${String(error)}${this.stderrTail()}`,
          ),
        );
      }
    } finally {
      this.close();
    }
  }

  private stderrTail(): string {
    const tail = this.stderr.join("").trim();
    return tail ? `\n${tail.slice(-2000)}` : "";
  }

  private handle(message: Record<string, unknown>): void {
    // Subagent output belongs to the agent loop, not to the client's turn.
    if (message.parent_tool_use_id) return;
    const turn = this.turn;
    if (!turn || turn.isSettled) return;

    switch (message.type) {
      case "stream_event":
        this.handleStreamEvent(turn, message.event as Record<string, unknown>);
        return;
      case "assistant":
        this.handleAssistant(turn, message);
        return;
      case "result":
        this.handleResult(turn, message);
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(turn: Turn, event: Record<string, unknown>): void {
    // The SDK reports each content block as its own assistant message, and a
    // parallel batch of tool calls spans several of them. Hand the batch out only
    // once the model's message has ended, or the later calls are never seen.
    if (event?.type === "message_stop") {
      if (turn.calls.length > 0) turn.finish("tool_use", turn.calls);
      return;
    }
    if (event?.type === "message_start") {
      const message = event.message as { usage?: unknown } | undefined;
      turn.callStarted({ ...usageFromResult(message?.usage), output_tokens: 0 });
      return;
    }
    if (event?.type === "message_delta") {
      const usage = event.usage as { output_tokens?: unknown } | undefined;
      if (typeof usage?.output_tokens === "number") turn.callOutputSoFar(usage.output_tokens);
      return;
    }
    if (event?.type !== "content_block_delta") return;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta) return;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      turn.emit({ type: "text", text: delta.text });
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      turn.emit({ type: "thinking", text: delta.thinking });
    }
  }

  private handleAssistant(turn: Turn, message: Record<string, unknown>): void {
    const error = message.error;
    if (typeof error === "string") {
      turn.fail(this.assistantError(error, assistantText(message)));
      return;
    }

    const payload = message.message as Record<string, unknown> | undefined;
    const blocks = Array.isArray(payload?.content) ? payload!.content : [];
    const bridge = this.options.tools;

    for (const raw of blocks as Array<Record<string, unknown>>) {
      if (raw.type === "text" && typeof raw.text === "string") {
        turn.addBlock({ type: "text", text: raw.text });
      } else if (raw.type === "thinking" && typeof raw.thinking === "string") {
        turn.addBlock({
          type: "thinking",
          thinking: raw.thinking,
          signature: typeof raw.signature === "string" ? raw.signature : undefined,
        });
      } else if (raw.type === "tool_use") {
        const clientName = bridge?.toClientName(String(raw.name));
        // A built-in tool the alias enabled: the SDK runs it, the client never
        // sees it, and the turn keeps going.
        if (!clientName) continue;
        const id = String(raw.id);
        const input = (raw.input ?? {}) as Record<string, unknown>;
        this.park({ id, clientName, input });
        turn.calls.push({ type: "tool_use", id, name: clientName, input });
      }
    }
  }

  /** Register an announced call, matching any MCP handler that arrived first. */
  private park(call: ParkedCall): void {
    const index = this.waiting.findIndex((w) => w.clientName === call.clientName);
    if (index >= 0) {
      call.resolve = this.waiting.splice(index, 1)[0]!.resolve;
    }
    this.parked.set(call.id, call);
  }

  private handleResult(turn: Turn, message: Record<string, unknown>): void {
    turn.setResultUsage(usageFromResult(message.usage));
    if (message.subtype !== "success") {
      const detail =
        typeof message.result === "string" && message.result
          ? message.result
          : String(message.subtype);
      turn.fail(new RelayError(`Agent SDK returned ${detail}${this.stderrTail()}`));
      return;
    }
    // A turn that produced no assistant blocks still owes the client something.
    if (turn.content.length === 0 && typeof message.result === "string") {
      turn.addBlock({ type: "text", text: message.result });
    }
    turn.finish(message.stop_reason === "max_tokens" ? "max_tokens" : "end_turn");
  }

  private assistantError(error: string, text: string): RelayError {
    switch (error) {
      case "authentication_failed":
      case "oauth_org_not_allowed":
        return new RelayError(
          "Claude Code is not authenticated. Set CLAUDE_CODE_OAUTH_TOKEN or mount a logged-in ~/.claude.",
          401,
          "authentication_error",
        );
      case "rate_limit":
        return new RelayError("Claude subscription rate limit reached.", 429, "rate_limit_error");
      case "overloaded":
        return new RelayError("Upstream overloaded.", 529, "overloaded_error");
      case "model_not_found":
        return new RelayError("Unknown model.", 404, "not_found_error");
      default:
        // The CLI puts the upstream API error in the message text; without it
        // an "unknown" error is undiagnosable.
        return new RelayError(
          `Agent SDK error: ${error}${text ? ` — ${text}` : ""}${this.stderrTail()}`,
        );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.parked.values()) {
      call.resolve?.({ content: [{ type: "text", text: "Session closed." }], isError: true });
    }
    this.parked.clear();
    this.inbox.close();
    this.abort.abort();
    this.onClose?.();
  }
}

/**
 * Live sessions, indexed by the tool_use ids they are waiting on, or, once a turn
 * has ended, by the conversation they hold, so the client's next turn can carry
 * on in the same session instead of replaying the history into a new one.
 */
export class SessionStore {
  private readonly sessions = new Set<Session>();
  private readonly byToolUseId = new Map<string, Session>();
  /** Sessions between turns, by conversation key, oldest first. */
  private readonly idle = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: Config) {}

  find(toolUseIds: string[]): Session | undefined {
    for (const id of toolUseIds) {
      const session = this.byToolUseId.get(id);
      if (session) return session;
    }
    return undefined;
  }

  add(session: Session): void {
    this.evictIfFull();
    this.sessions.add(session);
    session.setOnClose(() => this.forget(session));
    this.ensureSweeper();
  }

  /** Take the session that holds the conversation up to `key`, if one is waiting. */
  claimIdle(key: string): Session | undefined {
    const session = this.idle.get(key);
    if (session) this.idle.delete(key);
    return session;
  }

  /**
   * Called after each turn. A session with an open tool call waits for its
   * result; one whose turn ended waits under `idleKey` for the next user turn,
   * while there is room for it. Anything else is closed.
   */
  settle(session: Session, idleKey?: string): void {
    this.unindex(session);
    if (session.hasParkedCalls) {
      for (const id of session.toolUseIds) this.byToolUseId.set(id, session);
      return;
    }
    if (idleKey === undefined || this.config.maxIdleSessions <= 0) {
      session.close();
      return;
    }
    this.idle.set(idleKey, session);
    // Each one is a CLI process of its own, so only a few are kept around.
    while (this.idle.size > this.config.maxIdleSessions) {
      this.idle.values().next().value!.close();
    }
  }

  private unindex(session: Session): void {
    for (const [id, value] of this.byToolUseId) {
      if (value === session) this.byToolUseId.delete(id);
    }
    for (const [key, value] of this.idle) {
      if (value === session) this.idle.delete(key);
    }
  }

  private forget(session: Session): void {
    this.sessions.delete(session);
    this.unindex(session);
    if (this.sessions.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private isIdle(session: Session): boolean {
    return [...this.idle.values()].includes(session);
  }

  private evictIfFull(): void {
    while (this.sessions.size >= this.config.maxSessions) {
      // A session between turns only saves a replay; one waiting on a tool
      // result would lose the turn, so idle ones go first.
      const oldest = [...this.sessions].sort(
        (a, b) => Number(this.isIdle(b)) - Number(this.isIdle(a)) || a.lastUsed - b.lastUsed,
      )[0];
      if (!oldest) return;
      oldest.close();
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.sessions]) {
        const ttl = this.isIdle(session) ? this.config.idleTtlMs : this.config.sessionTtlMs;
        if (session.lastUsed < now - ttl) session.close();
      }
    }, 30_000);
    this.sweeper.unref?.();
  }

  closeAll(): void {
    for (const session of [...this.sessions]) session.close();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** The text blocks of an SDK assistant message, joined. */
function assistantText(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

export { buildToolBridge };
