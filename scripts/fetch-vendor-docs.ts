// Downloads the two vendor API specs into docs/ so you (or your coding agent) can check field names against the real
// thing instead of memory. The files are not committed: they are the vendors' documents, not ours.
//   npm run docs:fetch
// Hevy publishes its spec inside the Swagger page's script; Oura links its spec from its docs page, with a version number
// that changes, so the link is looked up each time. Read-only GETs of public pages; no keys needed.
import { mkdirSync, writeFileSync } from "node:fs";

async function get(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

// The swagger-ui-init.js script holds `var options = { "swaggerDoc": { ...the spec... }, ...`. Take the balanced {} after "swaggerDoc":.
export function extractSwaggerDoc(script: string): unknown {
  const at = script.indexOf('"swaggerDoc"');
  if (at < 0) throw new Error("no swaggerDoc in the Hevy docs script (the page changed; open https://api.hevyapp.com/docs)");
  const start = script.indexOf("{", at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(script.slice(start, i + 1));
  }
  throw new Error("the swaggerDoc object never closes");
}

export function findOuraSpecPath(html: string): string {
  const m = html.match(/static\/json\/openapi-[0-9.]+\.json/);
  if (!m) throw new Error("no openapi link on https://cloud.ouraring.com/v2/docs (the page changed)");
  return m[0];
}

async function main() {
  mkdirSync("docs", { recursive: true });
  const hevy = extractSwaggerDoc(await get("https://api.hevyapp.com/docs/swagger-ui-init.js"));
  writeFileSync("docs/hevy-openapi.json", JSON.stringify(hevy, null, 2));
  console.log("docs/hevy-openapi.json written");
  const path = findOuraSpecPath(await get("https://cloud.ouraring.com/v2/docs"));
  const oura = JSON.parse(await get(`https://cloud.ouraring.com/v2/${path}`));
  writeFileSync("docs/oura-openapi.json", JSON.stringify(oura, null, 2));
  console.log(`docs/oura-openapi.json written (from ${path})`);
}

if (process.argv[1]?.endsWith("fetch-vendor-docs.ts")) main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
