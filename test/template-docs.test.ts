import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The docs are part of the product: a step that names a script or file that doesn't exist is a bug.
const read = (p: string) => readFileSync(p, "utf8");
const pkg = JSON.parse(read("package.json"));

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (["node_modules", ".next", ".git"].includes(n)) continue;
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

describe("the setup docs", () => {
  const docs = ["AGENTS.md", "README.md", "DESIGN.md"].map((f) => [f, read(f)] as const);

  it("only name npm scripts that exist", () => {
    for (const [f, text] of docs) {
      for (const m of text.matchAll(/npm run ([a-z:-]+)/g)) expect(pkg.scripts[m[1]], `${f}: npm run ${m[1]}`).toBeDefined();
    }
  });

  it("only name repo paths that exist", () => {
    for (const [f, text] of docs) {
      for (const m of text.matchAll(/`((?:src|app|scripts|supabase|docs|test)\/[A-Za-z0-9_./-]+)`/g)) {
        const p = m[1].replace(/\/$/, "");
        if (/docs\/(hevy|oura)-openapi\.json/.test(p)) continue; // fetched by npm run docs:fetch, not committed
        expect(existsSync(p), `${f}: ${p}`).toBe(true);
      }
    }
  });

  it("CLAUDE.md just imports AGENTS.md, so one file serves every agent", () => {
    expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md");
    expect(existsSync(".cursor/rules")).toBe(false);
  });

  it("every environment variable the code reads is documented in .env.example", () => {
    const example = read(".env.example");
    const used = new Set<string>();
    for (const f of [...walk("src"), ...walk("app"), ...walk("scripts")].filter((p) => /\.tsx?$/.test(p))) {
      for (const m of read(f).matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
    }
    const platform = new Set(["VERCEL_PROJECT_PRODUCTION_URL", "NODE_ENV", "OURA_REDIRECT_URI", "HOME"]); // set by Vercel, or optional with a derived default
    for (const v of used) if (!platform.has(v)) expect(example, `${v} is read by the code but not in .env.example`).toContain(v);
  });
});

describe("the agent connectors", () => {
  const SUPABASE = "https://mcp.supabase.com/mcp", VERCEL = "https://mcp.vercel.com";
  it("each agent's file lists the Supabase and Vercel servers and holds no secret", () => {
    const claude = JSON.parse(read(".mcp.json")), cursor = JSON.parse(read(".cursor/mcp.json"));
    for (const cfg of [claude, cursor]) {
      expect(cfg.mcpServers.supabase.url).toBe(SUPABASE);
      expect(cfg.mcpServers.vercel.url).toBe(VERCEL);
    }
    expect(claude.mcpServers.supabase.type).toBe("http");
    const codex = read(".codex/config.toml");
    expect(codex).toContain(`url = "${SUPABASE}"`);
    expect(codex).toContain(`url = "${VERCEL}"`);
    for (const text of [read(".mcp.json"), read(".cursor/mcp.json"), codex]) {
      expect(/token|secret|password|authorization|api[-_]?key|bearer/i.test(text.replace(/^#.*$/gm, "")), "a connector file must hold no credential").toBe(false);
    }
  });
});
