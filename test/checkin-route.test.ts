import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/core/runtime", () => ({
  getRuntimeSql: () => { throw new Error("must not touch the database when unauthorized or invalid"); },
  getToolCtx: () => { throw new Error("must not touch the database when unauthorized or invalid"); },
}));

import { POST as checkin } from "../app/api/checkin/route";
import { GET as today } from "../app/api/checkin/today/route";
import { POST as ingest } from "../app/api/ingest/apple-health/route";
import { POST as mcp } from "../app/api/mcp/route";

const CHECKIN = "checkin-secret";
const MCP = "mcp-secret";
const INGEST = "ingest-secret";

beforeEach(() => {
  process.env.HUB_MODULES = "checkins";
  process.env.CHECKIN_KEY = CHECKIN;
  process.env.MCP_SECRET = MCP;
  process.env.INGEST_KEY = INGEST;
});

const post = (url: string, headers: Record<string, string>, body = "{}") =>
  new Request(url, { method: "POST", headers, body });

describe("check-in key separation", () => {
  it("refuses the check-in key on /api/mcp and /api/ingest/apple-health", async () => {
    const mcpRes = await mcp(post("http://x/api/mcp", { "x-api-key": CHECKIN, "content-type": "application/json", accept: "application/json, text/event-stream" }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
    expect(mcpRes.status).toBe(401);
    const ingestRes = await ingest(post("http://x/api/ingest/apple-health", { "x-ingest-key": CHECKIN }));
    expect(ingestRes.status).toBe(401);
  });

  it("refuses the MCP key and the ingest key on both check-in routes", async () => {
    for (const key of [MCP, INGEST, ""]) {
      expect((await checkin(post("http://x/api/checkin", { "x-checkin-key": key }, JSON.stringify({ rating: 4 })))).status).toBe(401);
      expect((await today(new Request("http://x/api/checkin/today", { headers: { "x-checkin-key": key } }))).status).toBe(401);
    }
    delete process.env.CHECKIN_KEY;
    expect((await checkin(post("http://x/api/checkin", { "x-checkin-key": CHECKIN }, JSON.stringify({ rating: 4 })))).status).toBe(401);
  });

  it("rejects 0, 6, 3.5 and text with 400 before any database use", async () => {
    for (const rating of [0, 6, 3.5, "good", "3.5"]) {
      const res = await checkin(post("http://x/api/checkin", { "x-checkin-key": CHECKIN }, JSON.stringify({ rating })));
      expect(res.status, String(rating)).toBe(400);
    }
    expect((await checkin(post("http://x/api/checkin", { "x-checkin-key": CHECKIN }, "not json"))).status).toBe(400);
  });
});
