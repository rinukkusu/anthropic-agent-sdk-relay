/**
 * Relay configuration, read once from the environment at startup.
 */

export type ModelAlias = {
  /** Model id handed to the Agent SDK. */
  model: string;
  /** Built-in Claude Code tools this alias may use. Empty means plain chat model. */
  tools: string[];
  /** Thinking effort, when the alias pins one. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

export type Config = {
  port: number;
  host: string;
  apiKey: string | null;
  models: Record<string, ModelAlias>;
  defaultModel: string;
  sessionTtlMs: number;
  maxSessions: number;
  toolTimeoutMs: number;
  cwd: string;
  logLevel: "debug" | "info" | "error";
  /**
   * Prompt cache TTL for the whole request. The CLI and the relay's own
   * breakpoint must agree: the API rejects a 1h breakpoint after a 5m one.
   */
  cacheTtl: "5m" | "1h";
};

const DEFAULT_MODELS: Record<string, ModelAlias> = {
  "claude-opus-5": { model: "claude-opus-5", tools: [] },
  "claude-sonnet-5": { model: "claude-sonnet-5", tools: [] },
  "claude-haiku-4-5": { model: "claude-haiku-4-5", tools: [] },
  "claude-opus-5-web": {
    model: "claude-opus-5",
    tools: ["WebSearch", "WebFetch"],
  },
  "claude-sonnet-5-web": {
    model: "claude-sonnet-5",
    tools: ["WebSearch", "WebFetch"],
  },
};

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function models(): Record<string, ModelAlias> {
  const raw = process.env.RELAY_MODELS;
  if (!raw) return DEFAULT_MODELS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`RELAY_MODELS is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("RELAY_MODELS must be a JSON object of alias -> config");
  }
  const out: Record<string, ModelAlias> = {};
  for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`RELAY_MODELS entry ${alias} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.model !== "string") {
      throw new Error(`RELAY_MODELS entry ${alias} needs a "model" string`);
    }
    out[alias] = {
      model: entry.model,
      tools: Array.isArray(entry.tools) ? (entry.tools as string[]) : [],
      effort: entry.effort as ModelAlias["effort"],
    };
  }
  return out;
}

function cacheTtl(): Config["cacheTtl"] {
  // The CLI honours this switch over any TTL it is given, so follow it.
  if (process.env.FORCE_PROMPT_CACHING_5M) return "5m";
  const raw = process.env.RELAY_CACHE_TTL ?? "1h";
  if (raw !== "5m" && raw !== "1h") {
    throw new Error(`RELAY_CACHE_TTL must be "5m" or "1h", got ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function loadConfig(): Config {
  const apiKey = process.env.RELAY_API_KEY ?? null;
  if (!apiKey && process.env.RELAY_ALLOW_ANONYMOUS !== "1") {
    throw new Error(
      "RELAY_API_KEY is not set. Set it, or set RELAY_ALLOW_ANONYMOUS=1 to run without a shared secret.",
    );
  }

  const table = models();
  const defaultModel =
    process.env.RELAY_DEFAULT_MODEL ?? Object.keys(table)[0] ?? "claude-sonnet-5";

  return {
    port: num("PORT", 8787),
    host: process.env.RELAY_HOST ?? "0.0.0.0",
    apiKey,
    models: table,
    defaultModel,
    sessionTtlMs: num("RELAY_SESSION_TTL_MS", 10 * 60 * 1000),
    maxSessions: num("RELAY_MAX_SESSIONS", 32),
    toolTimeoutMs: num("RELAY_TOOL_TIMEOUT_MS", 15 * 60 * 1000),
    cwd: process.env.RELAY_CWD ?? process.cwd(),
    logLevel: (process.env.RELAY_LOG_LEVEL as Config["logLevel"]) ?? "info",
    cacheTtl: cacheTtl(),
  };
}

/** Claude Code session variables that must not leak into the spawned CLI. */
const KEEP_CLAUDE_VARS = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_[A-Z_]+|MAX_OUTPUT_TOKENS|EXTRA_BODY)$/;

/**
 * The environment the Agent SDK subprocess runs in.
 *
 * Running the relay from inside a Claude Code session leaves that session's own
 * variables in `process.env`, and they point the spawned CLI at a host auth
 * channel that does not exist here. Everything Claude-Code-specific is dropped
 * except the credentials and provider switches the SDK genuinely reads.
 */
export function childEnv(config: Config): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "CLAUDECODE" || key === "CLAUDE_PID") continue;
    if (key.startsWith("CLAUDE_") && !KEEP_CLAUDE_VARS.test(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "anthropic-agent-sdk-relay";
  // Left to itself the CLI picks a TTL per account state, which need not match
  // the breakpoint the relay puts in the prompt.
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = config.cacheTtl;
  env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = config.cacheTtl;
  return env;
}

/**
 * Resolve a client-supplied model name. Unknown names pass straight through to
 * the Agent SDK with no built-in tools, so a client can name any model Claude
 * Code accepts without the relay needing to know about it first.
 */
export function resolveModel(config: Config, requested: string | undefined): ModelAlias {
  const name = requested ?? config.defaultModel;
  const alias = config.models[name];
  if (alias) return alias;
  return { model: name, tools: [] };
}
