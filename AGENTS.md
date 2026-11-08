# Health Hub: instructions for coding agents

You are helping a person set up and adapt their own Health Hub: a small server that joins their Oura ring, Apple Health, lab results and (optionally) Hevy workouts into one place their AI app (Claude, ChatGPT-style apps, Cursor, Codex) can read and write. This file is the setup guide. It works for any agent, and everything in it is a plain step or an `npm run` script.

Read this whole file first. Then `README.md` for what the project is, and `DESIGN.md` for how it is built and why.

## Rules that never bend

- **Secrets are entered by the person, never by you.** Never ask them to paste a key into chat, never print an env value, never put a secret in a file that is committed. Local secrets go in `.env.local` (git-ignored); production secrets go in Vercel's environment variables. To make a random key without showing it, use `printf 'NAME=%s\n' "$(openssl rand -hex 32)" >> .env.local`.
- **Ask before anything that costs money or can't be undone**: creating a Supabase or Vercel project, deleting anything, a first real write to Hevy. Say what it is, what it costs, and wait for a yes.
- **Use a free Supabase organization.** A project in a paid organization costs money.
- **This is health data. Never make a repo or a deployment that holds the person's real data public.** Their own copy of this template should be a private repository.
- **Every database table has row level security on, and the security advisor must be clean.** Run it after every schema change.
- **No test may call Hevy.** Hevy has no delete: anything written there is permanent. Use `dry_run` and the fake writer in `test/helpers/`.
- **Don't invent medical advice, ranges or genetic notes.** Use only what a source the person gave you says.
- Keep logic in `src/core` (no Next.js or Vercel imports there); `app/` holds thin adapters.

## Part 1: what you run

Do these in order. Each step names the MCP tool (Supabase and Vercel MCP servers are configured in `.mcp.json`, `.cursor/mcp.json` and `.codex/config.toml`; sign in to each with OAuth: Claude Code `/mcp`, Cursor "Needs login", Codex `codex mcp login supabase` and `codex mcp login vercel`) and the CLI fallback, so you can do it either way.

1. **Check the machine.** `node -v` must be 20.9 or newer (22 is what this was built on). Run `npm install`, then `npx tsc --noEmit` and `npm run test:fast`.
2. **Ask the person the questions in Part 3** and write their answers into `.env.local` (copy `.env.example` first). Settings first, because they decide which modules exist.
3. **Supabase.**
   - Ask which free organization to use, and which region (choose the one nearest to where the person lives; remember it, Vercel's region should match).
   - Create the project (MCP `get_cost`, `confirm_cost`, then `create_project`; CLI `supabase projects create`). Wait until it is healthy.
   - Apply the schema: the contents of `supabase/migrations/0001_schema.sql` (MCP `apply_migration`; CLI `supabase db push`).
   - Run the security advisor (MCP `get_advisors` type security). Expected: only INFO notes saying RLS is enabled with no policy, which is intended (only the server's own connection reads these tables). Anything else, fix.
   - `DATABASE_URL`: the person copies the **pooler** connection string (Project Settings, Database) into `.env.local` themselves. The password should use letters and numbers only. The code switches port 6543 to the session-mode port 5432 itself; don't change that (`src/core/db.ts` says why).
4. **Random keys.** Generate `MCP_SECRET`, `CRON_SECRET`, `INGEST_KEY` (and `CHECKIN_KEY` if the checkins or events module is on) with the `printf` line above.
5. **Check it locally.** `npm run doctor` prints PASS / FAIL / SKIP per check and never a value. Fix every FAIL. Then `npm test` with `DATABASE_URL` set: the database tests run inside transactions that are always rolled back, but run them before real data arrives anyway.
6. **Vercel.**
   - Put the code in the person's own **private** GitHub repository (MCP or `gh repo create --private`; ask first).
   - Create the Vercel project from it (CLI `vercel link`; the MCP can't create projects on every plan, so give the person dashboard steps if it refuses).
   - Set the same env vars from `.env.local` in Vercel (CLI `vercel env add NAME production`; the person types or pipes the values, you never display them). Also set `HUB_MODULES` if any module is on.
   - Set the function region to match Supabase's region (Project Settings, Functions). Without this every request crosses the country.
   - Deploy. `curl https://<app>.vercel.app/api/health` must answer `{"ok":true}`.
7. **Check production.** Call the MCP endpoint's `tools/list` with the `x-api-key` header (the person provides the key to the tool, you don't read it back) and compare with the modules they chose. The daily cron (`vercel.json`) runs at 16:00 UTC; Vercel's Hobby plan allows daily crons.
8. **Hand over** to Part 2: tell the person exactly which manual steps remain.

## Part 2: what the person does by hand

Give them these as numbered steps, one at a time, and wait for each.

1. **Hevy (optional).** Needs Hevy Pro. In the Hevy app: Settings, Developer, copy the API key. Put it in `.env.local` and Vercel as `HEVY_API_KEY`. Skip it and the hub simply has no Hevy tools.
2. **Oura.** Create an Oura API application in Oura's developer portal (https://developer.ouraring.com; check Oura's current docs, the portal moves). Redirect URI: `https://<app>.vercel.app/api/oura/callback`, exactly. Put the client id and secret in `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET`. **Read Oura's API terms yourself:** they restrict storing Oura data and sending it to an AI, and you decide whether your use is acceptable. Then redeploy, and ask your AI app to run `connect_oura` and open the link it gives you (single use, valid 10 minutes).
3. **Connect the hub to your AI app.**
   - Claude (desktop, web, phone): Settings, Connectors, add a custom connector with URL `https://<app>.vercel.app/api/mcp` and the header `x-api-key: <MCP_SECRET>`. Write tools ask for approval; read tools can be set to always allow. After any deploy that adds tools, start a new chat or reconnect: the connector caches the tool list.
   - Cursor: in `mcp.json`, add the server with `"url": "https://<app>.vercel.app/api/mcp"` and `"headers": { "x-api-key": "${env:HEALTH_HUB_KEY}" }`, with that environment variable set in your shell.
   - Codex: in `config.toml`, `[mcp_servers.health-hub]` with `url = "https://<app>.vercel.app/api/mcp"` and `env_http_headers = { "x-api-key" = "HEALTH_HUB_KEY" }`.
   - The phone and "Coach" experience was built and tested in Claude. The other apps can call every tool but have not been tested as a phone coach.
4. **Apple Health through Health Auto Export** (paid Premium app; the phone pushes data, the server can't pull it). Create REST API automations: URL `https://<app>.vercel.app/api/ingest/apple-health`, POST, JSON, header `X-Ingest-Key` set to `INGEST_KEY`, Export Version 2, batch requests on, cadence 1 hour. Use **two** automations, because a setting changes what the data means:
   - *Hub - body*: weight, body fat, lean mass and BMI only, **Summarize Data OFF** (only unsummarised readings keep their `source`, which is how the hub tells the scale from other apps' entries).
   - *Hub - everything else*: only the metrics your phone really has (steps, distance, energy, flights, exercise and stand time, walking metrics), **Summarize ON, Time Grouping = Hours**. Don't select all ~100 metrics: empty ones eat iOS's ~30 second background limit. Leave out what Oura already provides (heart rate, HRV, sleep, blood oxygen, temperature).
   - Never change an existing automation's time grouping after data has arrived.
5. **The Coach project.** Fill in `docs/coach-instructions.txt` (see Part 3), and paste the whole file into your AI app's project instructions. It is plain text on purpose.
6. **Optional phone shortcuts.** `docs/checkin-shortcut.md` builds the morning rating and the one-press event button.
7. **Labs.** Either export from Apple Health (`npm run import:apple-export -- ~/Downloads/export.zip` is a dry run; add `--apply` to save) or give your AI app a PDF or photo and let it call `log_lab_results` (it previews first).

## Part 3: make it yours

Ask these, then edit settings and text. Don't assume any answer.

- Timezone (IANA name) and units: `TIMEZONE`, `UNITS`.
- Which optional modules: `HUB_MODULES` from `checkins` (morning rating), `classes` (class-board photo to Hevy workout; needs Hevy), `genetics`, `events` (one-press phone button).
- Their devices: is there an Oura ring, a scale that writes to Apple Health, a Watch? (Delete Coach lines about devices they lack.)
- Heart-rate zones: `HR_ZONES` from their Oura app (the default is only an example).
- Goals, training schedule, targets, constraints: fill every `[FILL IN]` in `docs/coach-instructions.txt`; delete sections for modules that are off. Don't hard-code facts the person hasn't decided (a weekly schedule, targets).
- Labs: do they have an "optimal range" list they trust? If so add it to `OPTIMAL_RANGES` in `src/core/labs/ranges.ts` (format and one made-up example are in the file); if not, leave it empty, the lab's own range is the safe default. If two labs may report the same result, set `LAB_PREFERRED_PERFORMERS`.
- Genetic variants: only if they have a report. Add notes in `src/core/genetics/notes.ts` for variants they carry, from a source you checked; never repeat a vendor's "% functioning", personality or supplement claims; never invent an rsID.
- Class movements: edit `MOVEMENT_ALIASES` in `src/core/classes/aliases.ts` for their gym's wording.
- Fixed in code (change the constant, then the tests): the 60-night baseline (`BASELINE_DAYS` in `src/core/oura/recovery.ts`; a median that one bad night can't drag), the "on time" window for a morning rating (`onTime` in `src/core/checkins/validate.ts`), the main barbell lifts (`src/core/lifts.ts`). The scale is whichever source has the most weigh-ins; steps come from Oura.

## Part 4: lessons that cost real time (read before changing data code)

- **Live APIs differ from their docs.** Before relying on a shape, make one read-only call and look at its structure (print keys, not data). `npm run docs:fetch` downloads Hevy's and Oura's specs into `docs/`. Parse defensively; fail loudly on anything unexpected.
- **Capture before you parse** an unknown format: store the raw body, look at its structure with SQL, then write fixtures and the parser. Unknown shapes are skipped and counted, never guessed.
- **Imports default to a dry run** that prints counts and dates only. `--apply` writes. A second `--apply` must add 0 rows (idempotent, with a natural key).
- **A vendor setting can change what data means** (Health Auto Export's Summarize drops sources; its Metric mode sends kJ). Read the vendor's help pages before telling the person which toggles to press.
- **Mixing time grains double counts.** Never change a feed's grouping after data exists. One source is the truth per metric; list the others, never blend them.
- **Syncs must re-fetch as far back as the source can be late** (Oura: 3 days). A gap in heart-rate coverage is never a low heart rate.
- **Never convert a unit you aren't sure of.** Only well-known pairs (glucose and cholesterol) are converted, on read, and the answer says so.
- **Verdicts (better / worse) need a "meaningful change" threshold;** below it report the number and no verdict. Not countable is never 0: leave it out and list it.
- **Hevy writes are permanent:** dry run first, the write-ahead audit log, never retry a write, and a "redo" means the person deletes it in the Hevy app, then `sync_now source hevy`, then `replaces_session_id`.
- **Every read tool answers within a deadline** (25 s), every outbound call has a timeout, and nothing keeps running "in the background" on the single database connection.
- **Database tests use always-rolled-back transactions** with synthetic data (dates in 2031) and look rows up by their own ids. Test files run at most 6 at once (the session pooler allows about 15 clients). Use `npm run test:fast` while building, the full `npm test` once at the end.
- **Docs edits: assert each anchor** in the script that makes the change, or a silent miss produces a false "docs updated".
- **After a deploy that adds tools, the connector may show the old list** until a new chat or reconnect.

## Part 5: the map

- `src/core/`: all logic. `oura/`, `hevy/`, `apple/`, `labs/`, `genetics/`, `checkins/`, `events/`, `classes/`, `compare/` (any exercise against last time, and board completion), `tools/` (what each MCP tool returns), `modules.ts` (the switch), `doctor.ts`.
- `app/api/mcp/`: `hub.ts` registers tools by area (`tools/*.ts`); `route.ts` is the auth gate. Other routes: `ingest/apple-health`, `checkin`, `events`, `oura/callback`, `cron/daily`, `health`.
- `supabase/migrations/0001_schema.sql`: the whole schema. Add `0002_*.sql` for changes.
- `scripts/`: `doctor`, `docs:fetch`, imports and backfills (dry run by default), `review:class-boards`.
- Commands: `npm run dev`, `npm test`, `npm run test:fast`, `npx tsc --noEmit`, `npm run doctor`.
- Keep `DESIGN.md` and `README.md` in step with any behavior change, in the same commit.
