import { moduleOff } from "../moduleGate";
import { isAuthorized } from "@/core/auth";
import { saveShortcutCheckin } from "@/core/checkins/log";
import { parseShortcutBody } from "@/core/checkins/validate";
import { getToolCtx } from "@/core/runtime";
import { ToolError } from "@/core/tools/context";

export const maxDuration = 60;

// The Shortcut's endpoint (DESIGN §4.5). CHECKIN_KEY opens ONLY this route and
// GET /api/checkin/today. A leaked phone key can write a 1-5 rating and nothing else.
export async function POST(req: Request) {
  const off = moduleOff("checkins");
  if (off) return off;
  if (!isAuthorized(req.headers.get("x-checkin-key"), process.env.CHECKIN_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  let parsed: { rating: number; note: string | null };
  try {
    parsed = parseShortcutBody(payload);
  } catch (err) {
    if (err instanceof ToolError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
  try {
    const result = await saveShortcutCheckin(getToolCtx(), parsed);
    console.log("checkin", JSON.stringify({ saved: true, day: result.day }));
    return Response.json(result);
  } catch (err) {
    console.error("checkin failed", (err as Error).message);
    return Response.json({ error: "check-in failed" }, { status: 500 });
  }
}
