import { moduleOff } from "../moduleGate";
import { isAuthorized } from "@/core/auth";
import { logPress, parseEventType } from "@/core/events/log";
import { getToolCtx } from "@/core/runtime";
import { ToolError } from "@/core/tools/context";

export const maxDuration = 60;

// The phone's one-press endpoint (DESIGN Phase 17). CHECKIN_KEY opens ONLY POST /api/checkin, GET /api/checkin/today
// and this route: a leaked phone key can write a rating or a timestamped press and read nothing.
// The body names only the TYPE; the hub stamps the time on arrival.
export async function POST(req: Request) {
  const off = moduleOff("events");
  if (off) return off;
  if (!isAuthorized(req.headers.get("x-checkin-key"), process.env.CHECKIN_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let type;
  try {
    const payload = JSON.parse(await req.text());
    type = parseEventType(payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined);
  } catch (err) {
    if (err instanceof ToolError) return Response.json({ error: err.message }, { status: 400 });
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  try {
    const r = await logPress(getToolCtx(), { type, source: "shortcut" });
    console.log("event", JSON.stringify({ type, id: r.id, duplicate: r.duplicate }));
    return Response.json({ message: r.message, id: r.id });
  } catch (err) {
    console.error("event failed", (err as Error).message);
    return Response.json({ error: "event failed" }, { status: 500 });
  }
}
