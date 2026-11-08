import { HUB_KEY_HEADER, isAuthorized } from "@/core/auth";
import { buildHub } from "./hub";

export const maxDuration = 60; // seconds; a backfill stops itself before this

// Auth gate (DESIGN §6; header name in src/core/auth.ts): reject before the MCP handler ever sees the request.
function guarded(req: Request): Promise<Response> | Response {
  if (!isAuthorized(req.headers.get(HUB_KEY_HEADER), process.env.MCP_SECRET)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return buildHub()(req);
}

export { guarded as GET, guarded as POST };
