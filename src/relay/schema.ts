/**
 * JSON Schema to Zod.
 *
 * The Agent SDK's `tool()` helper takes a Zod raw shape, while Anthropic clients
 * declare tools with JSON Schema. This covers the subset those clients actually
 * emit (n8n and LangChain produce plain object schemas); anything unrecognised
 * degrades to `z.any()` rather than throwing, because a slightly loose schema is
 * far better than a tool the model cannot call at all.
 */
import { z } from "zod";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withMeta(type: z.ZodTypeAny, schema: Json): z.ZodTypeAny {
  const description = schema.description;
  return typeof description === "string" && description
    ? type.describe(description)
    : type;
}

function primitive(name: string): z.ZodTypeAny {
  switch (name) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default:
      return z.any();
  }
}

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!isObject(schema)) return z.any();

  // enum / const win over `type`, since they are the tighter statement.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum;
    if (values.every((v) => typeof v === "string")) {
      return withMeta(z.enum(values as string[]), schema);
    }
    return withMeta(
      z.union(values.map((v) => z.literal(v as never)) as never),
      schema,
    );
  }
  if ("const" in schema) {
    return withMeta(z.literal(schema.const as never), schema);
  }

  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches) && branches.length > 0) {
    const options = branches.map(jsonSchemaToZod);
    if (options.length === 1) return withMeta(options[0]!, schema);
    return withMeta(z.union(options as never), schema);
  }

  const type = schema.type;

  // `type: ["string", "null"]` and friends.
  if (Array.isArray(type)) {
    const options = type.map((t) => primitive(String(t)));
    if (options.length === 1) return withMeta(options[0]!, schema);
    return withMeta(z.union(options as never), schema);
  }

  if (type === "object" || (type === undefined && isObject(schema.properties))) {
    const shape = jsonSchemaToShape(schema);
    let object = z.object(shape);
    if (schema.additionalProperties !== false) {
      return withMeta(object.catchall(z.any()), schema);
    }
    return withMeta(object, schema);
  }

  if (type === "array") {
    const items = "items" in schema ? jsonSchemaToZod(schema.items) : z.any();
    return withMeta(z.array(items), schema);
  }

  if (typeof type === "string") {
    return withMeta(primitive(type), schema);
  }

  return z.any();
}

/**
 * Convert an object schema into the raw shape `tool()` expects. Properties not
 * listed in `required` become optional.
 */
export function jsonSchemaToShape(schema: unknown): z.ZodRawShape {
  if (!isObject(schema) || !isObject(schema.properties)) return {};

  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    const field = jsonSchemaToZod(value);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape as z.ZodRawShape;
}
