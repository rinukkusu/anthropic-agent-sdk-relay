/**
 * anthropic-agent-sdk-relay
 *
 * Speaks the Anthropic Messages API on the front, drives the Claude Agent SDK on
 * the back, so a self-hosted n8n can use a Claude subscription instead of
 * per-token API billing.
 */
import { loadConfig } from "./config.ts";
import { errorResponse } from "./relay/anthropic.ts";
import { SessionStore } from "./relay/session.ts";
import { handleMessages } from "./routes/messages.ts";
import { handleModels } from "./routes/models.ts";

const config = loadConfig();
const store = new SessionStore(config);

/** Length-independent comparison, so the shared secret can't be timed out. */
function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function authorized(request: Request): boolean {
  if (!config.apiKey) return true;
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  return (
    secretMatches(request.headers.get("x-api-key"), config.apiKey) ||
    secretMatches(bearer, config.apiKey)
  );
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", sessions: store.size });
    }

    if (!authorized(request)) {
      return errorResponse(401, "authentication_error", "Invalid or missing API key.");
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return handleModels(config);
    }

    if (url.pathname === "/v1/messages" && request.method === "POST") {
      return handleMessages(request, { config, store });
    }

    return errorResponse(404, "not_found_error", `No route for ${request.method} ${url.pathname}`);
  },
});

console.log(
  `relay listening on http://${config.host}:${server.port} — models: ${Object.keys(config.models).join(", ")}`,
);
if (!config.apiKey) {
  console.warn("RELAY_ALLOW_ANONYMOUS=1: every caller that can reach this port can use your Claude subscription.");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    store.closeAll();
    void server.stop(true).then(() => process.exit(0));
  });
}
