import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { ensureFresh } from "@/core/freshness";
import { getOuraRuntime, getSyncDeps, getToolCtx, resetRuntime } from "@/core/runtime";
import { runRead } from "@/core/tools/run";
import { ToolError, type ToolCtx } from "@/core/tools/context";

export type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

export const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

// Every read tool goes through here (src/core/tools/run.ts): a quick capped refresh first (DESIGN D3), then the
// query, then `as_of` so Claude can say how fresh the answer is; always an answer within READ_DEADLINE_MS, and one
// log line per call. A problem the caller can fix comes back as a plain error message, not a crash.
export async function readTool(tool: string, fn: (ctx: ToolCtx) => Promise<object>, opts: { oura?: boolean } = {}) {
  try {
    return json(await runRead({
      tool,
      oura: !!opts.oura,
      refresh: () => ensureFresh(getSyncDeps(), opts.oura ? (getOuraRuntime()?.deps ?? null) : null),
      query: () => fn(getToolCtx()),
      onDeadline: resetRuntime,
    }));
  } catch (err) {
    if (err instanceof ToolError) return { ...json({ error: err.message }), isError: true };
    throw err;
  }
}
export const READ = { readOnlyHint: true } as const;

// Write tools skip the lazy refresh (they don't read Hevy history) and report
// any ToolError as a normal message the model can act on.
export async function writeTool(fn: (ctx: ToolCtx) => Promise<object>) {
  try {
    return json(await fn(getToolCtx()));
  } catch (err) {
    if (err instanceof ToolError) return { ...json({ error: err.message }), isError: true };
    throw err;
  }
}

