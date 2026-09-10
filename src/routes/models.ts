/** GET /v1/models */
import type { Config } from "../config.ts";

export function handleModels(config: Config): Response {
  const created = "2026-01-01T00:00:00Z";
  const data = Object.entries(config.models).map(([id, alias]) => ({
    type: "model",
    id,
    display_name: alias.tools.length ? `${id} (${alias.tools.join(", ")})` : id,
    created_at: created,
  }));

  return Response.json({
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
}
