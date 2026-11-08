import { describe, it, expect } from "vitest";
import { constantTimeEqual, isAuthorized } from "@/core/auth";
import { ping } from "@/core/tools/ping";

describe("constantTimeEqual", () => {
  it("matches equal strings", () => expect(constantTimeEqual("abc", "abc")).toBe(true));
  it("rejects different strings", () => expect(constantTimeEqual("abc", "abd")).toBe(false));
  it("rejects different lengths without throwing", () =>
    expect(constantTimeEqual("abc", "abcd")).toBe(false));
});

describe("isAuthorized", () => {
  const secret = "s3cret-value";
  it("accepts the right key", () => expect(isAuthorized(secret, secret)).toBe(true));
  it("rejects a wrong key", () => expect(isAuthorized("nope", secret)).toBe(false));
  it("rejects a missing header", () => {
    expect(isAuthorized(null, secret)).toBe(false);
    expect(isAuthorized("", secret)).toBe(false);
  });
  it("fails closed when no secret is configured", () => {
    expect(isAuthorized("anything", undefined)).toBe(false);
    expect(isAuthorized("", "")).toBe(false);
  });
});

describe("ping", () => {
  it("returns ok and a UTC ISO time", () => {
    expect(ping(new Date("2026-10-10T17:17:43Z"))).toEqual({
      ok: true,
      time: "2026-10-10T17:17:43.000Z",
    });
  });
});

import { isBearerAuthorized } from "@/core/auth";

describe("isBearerAuthorized (cron)", () => {
  it("accepts the right bearer token", () =>
    expect(isBearerAuthorized("Bearer abc", "abc")).toBe(true));
  it("rejects wrong, missing, or non-Bearer values", () => {
    expect(isBearerAuthorized("Bearer nope", "abc")).toBe(false);
    expect(isBearerAuthorized(null, "abc")).toBe(false);
    expect(isBearerAuthorized("abc", "abc")).toBe(false);
  });
  it("fails closed with no secret configured", () => {
    expect(isBearerAuthorized("Bearer ", undefined)).toBe(false);
    expect(isBearerAuthorized("Bearer x", "")).toBe(false);
  });
});
