import { describe, expect, test } from "bun:test";
import { normalizePath } from "../src/routes/path.ts";

describe("normalizePath", () => {
  test("leaves a well-formed path alone", () => {
    expect(normalizePath("/v1/messages")).toBe("/v1/messages");
    expect(normalizePath("/health")).toBe("/health");
  });

  test("survives a base URL configured with a trailing slash", () => {
    expect(normalizePath("//v1/messages")).toBe("/v1/messages");
    expect(normalizePath("///v1//models")).toBe("/v1/models");
  });

  test("drops a trailing slash without eating the root", () => {
    expect(normalizePath("/v1/messages/")).toBe("/v1/messages");
    expect(normalizePath("/")).toBe("/");
  });
});
