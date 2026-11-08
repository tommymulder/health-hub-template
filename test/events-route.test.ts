import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/core/runtime", () => ({
  getRuntimeSql: () => { throw new Error("must not touch the database when unauthorized or invalid"); },
  getToolCtx: () => { throw new Error("must not touch the database when unauthorized or invalid"); },
}));

import { POST as events } from "../app/api/events/route";
import { POST as mcp } from "../app/api/mcp/route";

const CHECKIN = "checkin-secret", MCP = "mcp-secret", INGEST = "ingest-secret";
beforeEach(() => { process.env.HUB_MODULES = "events"; process.env.CHECKIN_KEY = CHECKIN; process.env.MCP_SECRET = MCP; process.env.INGEST_KEY = INGEST; });
const post = (headers: Record<string, string>, body = JSON.stringify({ type: "bathroom" })) => new Request("http://x/api/events", { method: "POST", headers, body });

describe("POST /api/events: the phone's write-only key", () => {
  it("401 without a key, and with the MCP key or the ingest key", async () => {
    for (const key of [MCP, INGEST, ""]) expect((await events(post({ "x-checkin-key": key }))).status).toBe(401);
    expect((await events(post({}))).status).toBe(401);
    delete process.env.CHECKIN_KEY;
    expect((await events(post({ "x-checkin-key": CHECKIN }))).status).toBe(401); // no configured key never authorizes
  });
  it("400 for an unknown type, a missing type, or a body that is not JSON (before any database use)", async () => {
    for (const body of [JSON.stringify({ type: "coffee" }), JSON.stringify({}), JSON.stringify({ type: 5 }), "not json", JSON.stringify([1])])
      expect((await events(post({ "x-checkin-key": CHECKIN }, body))).status, body).toBe(400);
  });
  it("the phone key still opens nothing that reads health data", async () => {
    const res = await mcp(new Request("http://x/api/mcp", { method: "POST", headers: { "x-api-key": CHECKIN, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(res.status).toBe(401);
  });
});
