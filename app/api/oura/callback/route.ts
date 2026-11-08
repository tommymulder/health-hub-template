import { getOuraConfig } from "@/core/config";
import { completeOuraConnect, OuraConnectError } from "@/core/oura/connect";
import { getRuntimeSql } from "@/core/runtime";

// Public by necessity (Oura redirects the browser here), protected by the single-use
// `state` the hub issued. It shows a plain message and never echoes any data or error detail.
const page = (title: string, body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Health Hub</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h2>${title}</h2><p>${body}</p></body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  try {
    const cfg = getOuraConfig();
    await completeOuraConnect({ sql: getRuntimeSql(), ...cfg }, { state: q.get("state"), code: q.get("code"), error: q.get("error") });
    return page("Oura connected", "You can close this tab and go back to Claude. Ask it to run sync_now to start the first download.");
  } catch (err) {
    if (err instanceof OuraConnectError) return page("Couldn't connect Oura", err.message, 400);
    console.error("oura callback failed", (err as Error).message);
    return page("Couldn't connect Oura", "Something went wrong on the server. Ask Claude to check the sync status, then try connect_oura again.", 500);
  }
}
