import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsonSchemaToShape, jsonSchemaToZod } from "../src/relay/schema.ts";

describe("jsonSchemaToShape", () => {
  test("maps a typical tool schema, marking unlisted properties optional", () => {
    const shape = jsonSchemaToShape({
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        units: { type: "string", enum: ["c", "f"] },
        days: { type: "integer" },
      },
      required: ["city"],
    });

    const object = z.object(shape);
    expect(object.parse({ city: "Vienna" })).toEqual({ city: "Vienna" });
    expect(object.parse({ city: "Vienna", units: "c", days: 3 })).toEqual({
      city: "Vienna",
      units: "c",
      days: 3,
    });
    expect(() => object.parse({})).toThrow();
    expect(() => object.parse({ city: "Vienna", units: "kelvin" })).toThrow();
  });

  test("returns an empty shape for a schema with no properties", () => {
    expect(jsonSchemaToShape({ type: "object" })).toEqual({});
    expect(jsonSchemaToShape(undefined)).toEqual({});
  });
});

describe("jsonSchemaToZod", () => {
  test("handles arrays, nested objects and nullable unions", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        owner: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
          additionalProperties: false,
        },
        note: { type: ["string", "null"] },
      },
      required: ["tags", "owner", "note"],
      additionalProperties: false,
    });

    expect(schema.parse({ tags: ["a"], owner: { id: 1 }, note: null })).toEqual({
      tags: ["a"],
      owner: { id: 1 },
      note: null,
    });
    expect(() => schema.parse({ tags: "a", owner: { id: 1 }, note: null })).toThrow();
  });

  test("falls back to any rather than throwing on an unknown schema", () => {
    expect(jsonSchemaToZod({ type: "wat" }).parse("anything")).toBe("anything");
    expect(jsonSchemaToZod(null).parse(42)).toBe(42);
  });

  test("keeps additional properties when the schema allows them", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    expect(schema.parse({ a: "x", extra: 1 })).toEqual({ a: "x", extra: 1 });
  });
});
