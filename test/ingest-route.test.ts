import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/core/runtime", () => ({ getRuntimeSql: () => { throw new Error("must not touch the database when unauthorized"); } }));
import { POST } from "../app/api/ingest/apple-health/route";

const req = (headers: Record<string, string>, body = "{}") =>
  new Request("http://x/api/ingest/apple-health", { method: "POST", headers, body });

describe("ingest route auth", () => {
  beforeEach(() => { process.env.INGEST_KEY = "ingest-secret"; process.env.MCP_SECRET = "mcp-secret"; });
  it("rejects a missing key", async () => expect((await POST(req({}))).status).toBe(401));
  it("rejects the MCP key (separate keys, D13)", async () =>
    expect((await POST(req({ "x-ingest-key": "mcp-secret" }))).status).toBe(401));
  it("rejects everything when INGEST_KEY is unset (fail closed)", async () => {
    delete process.env.INGEST_KEY;
    expect((await POST(req({ "x-ingest-key": "" }))).status).toBe(401);
  });
  it("answers 400 for non-JSON after a valid key, before any database use", async () =>
    expect((await POST(req({ "x-ingest-key": "ingest-secret" }, "not json"))).status).toBe(400));
});
