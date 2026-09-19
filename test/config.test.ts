import { describe, expect, test } from "bun:test";
import { loadConfig, resolveModel, type Config } from "../src/config.ts";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("loadConfig", () => {
  test("refuses to start without a shared secret", () => {
    withEnv({ RELAY_API_KEY: undefined, RELAY_ALLOW_ANONYMOUS: undefined }, () => {
      expect(() => loadConfig()).toThrow(/RELAY_API_KEY/);
    });
  });

  test("allows an explicitly anonymous relay", () => {
    withEnv({ RELAY_API_KEY: undefined, RELAY_ALLOW_ANONYMOUS: "1" }, () => {
      expect(loadConfig().apiKey).toBeNull();
    });
  });

  test("reads a model table from the environment", () => {
    withEnv(
      {
        RELAY_API_KEY: "secret",
        RELAY_MODELS: JSON.stringify({
          cheap: { model: "claude-haiku-4-5", tools: ["WebSearch"], effort: "low" },
        }),
      },
      () => {
        const config = loadConfig();
        expect(config.models.cheap).toEqual({
          model: "claude-haiku-4-5",
          tools: ["WebSearch"],
          effort: "low",
        });
        expect(config.defaultModel).toBe("cheap");
      },
    );
  });

  test("rejects a malformed model table instead of starting half-configured", () => {
    withEnv({ RELAY_API_KEY: "secret", RELAY_MODELS: "{" }, () => {
      expect(() => loadConfig()).toThrow(/valid JSON/);
    });
    withEnv({ RELAY_API_KEY: "secret", RELAY_MODELS: '{"a":{}}' }, () => {
      expect(() => loadConfig()).toThrow(/needs a "model" string/);
    });
  });

  test("floors the session TTL at the tool timeout so parked calls are not swept", () => {
    // A configured TTL shorter than the tool timeout is raised to the timeout,
    // so the sweeper never kills a session while a tool call is still parked.
    withEnv(
      {
        RELAY_API_KEY: "secret",
        RELAY_SESSION_TTL_MS: String(5 * 60 * 1000),
        RELAY_TOOL_TIMEOUT_MS: String(15 * 60 * 1000),
      },
      () => {
        const config = loadConfig();
        expect(config.sessionTtlMs).toBe(15 * 60 * 1000);
        expect(config.sessionTtlMs).toBeGreaterThanOrEqual(config.toolTimeoutMs);
      },
    );
    // A TTL that already exceeds the tool timeout is left untouched.
    withEnv(
      {
        RELAY_API_KEY: "secret",
        RELAY_SESSION_TTL_MS: String(20 * 60 * 1000),
        RELAY_TOOL_TIMEOUT_MS: String(15 * 60 * 1000),
      },
      () => {
        expect(loadConfig().sessionTtlMs).toBe(20 * 60 * 1000);
      },
    );
  });
});

describe("resolveModel", () => {
  const config = withEnv({ RELAY_API_KEY: "secret", RELAY_MODELS: undefined }, () =>
    loadConfig(),
  ) as Config;

  test("resolves a known alias to its tools", () => {
    expect(resolveModel(config, "claude-sonnet-5-web")).toEqual({
      model: "claude-sonnet-5",
      tools: ["WebSearch", "WebFetch"],
      effort: undefined,
    });
  });

  test("passes an unknown model through with no built-in tools", () => {
    expect(resolveModel(config, "claude-opus-4-8")).toEqual({
      model: "claude-opus-4-8",
      tools: [],
    });
  });

  test("falls back to the default model when none is named", () => {
    expect(resolveModel(config, undefined).model).toBe(config.models[config.defaultModel]!.model);
  });
});
