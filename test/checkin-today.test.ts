import { describe, it, expect, vi, beforeEach } from "vitest";

// A fake database: the route only asks "is there a row for today?".
let rows: { n: number }[] = [];
vi.mock("@/core/runtime", () => ({
  getToolCtx: () => ({
    sql: () => Promise.resolve(rows),
    timezone: "America/Los_Angeles",
    units: "lb",
  }),
}));

import { GET as today } from "../app/api/checkin/today/route";

const KEY = "checkin-secret";
beforeEach(() => { process.env.HUB_MODULES = "checkins"; process.env.CHECKIN_KEY = KEY; });
const ask = () => today(new Request("http://x/api/checkin/today", { headers: { "x-checkin-key": KEY } }));

describe("GET /api/checkin/today", () => {
  // Shortcuts counts JSON false as "has a value", so the 9:00 automation compares the
  // plain-text status instead. Both branches must be distinguishable as text.
  it("says not_logged as plain text when today has no rating", async () => {
    rows = [];
    expect(await (await ask()).json()).toEqual({ logged: false, status: "not_logged" });
  });
  it("says logged as plain text when today has a rating, and never returns the rating", async () => {
    rows = [{ n: 1 }];
    const body = await (await ask()).json();
    expect(body).toEqual({ logged: true, status: "logged" });
    expect(JSON.stringify(body)).not.toMatch(/rating/);
  });
});
