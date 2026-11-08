# Health Hub: how it is built

A short design for people who want to change it. It describes the architecture and the decisions behind it, not any one person's setup.

## What it is

A **remote MCP server** (the protocol AI apps use to call tools) that runs on Vercel and stores everything in one Supabase Postgres database. One user, one deployment. The AI app calls tools like `get_recovery`; the server answers from the database, refreshing from the sources first when the data is old.

```
Oura API ──────────┐                          ┌── get_recovery, get_trends, ...
Hevy API ──────────┤   sync (daily cron +     │
Health Auto Export ┼─► lazy refresh before  ─►├── Postgres (RLS on) ─► tools ─► AI app
  (phone pushes)   │   a read) / ingest route │
Phone shortcuts ───┘                          └── write tools (labs, routines, ...)
```

Stack: Next.js (App Router) on Vercel with `mcp-handler`; TypeScript; raw SQL through `postgres` (no ORM); Zod for tool inputs; Vitest.

## Decisions that shape the code

- **D1 Logic in `src/core`, adapters in `app/`.** Nothing in `src/core` imports Next.js or Vercel packages, so the logic can move to another host and is testable without a server.
- **D2 One user, one key.** Every MCP call needs `x-api-key`. The phone routes use separate keys that open only their own routes, so a leaked phone key can write a rating or an event and read nothing.
- **D3 Lazy refresh.** A read tool that finds data older than 3 hours does a quick, capped incremental sync first, under a lease so simultaneous calls don't each start one, and always answers within a deadline (25 s). A daily cron is the safety net. Answers carry `as_of` so the AI can say how fresh they are.
- **D4 RLS on every table, no policies.** The database is never exposed through Supabase's public API; only the server's own connection (the owner) reads and writes. The security advisor must be clean (INFO notes about "RLS enabled, no policy" are the intent).
- **D5 Own keys, own app.** Each person registers their own Oura application. The template ships no credentials.
- **D6 Baselines are the person's own.** HRV and resting heart rate are compared with a 60-night rolling **median** (steady against one bad night), and a recommendation to back off needs both to move the wrong way together. Below a "meaningful change" threshold the tools give the number and no better/worse verdict.
- **D7 Imports are dry runs by default** and idempotent: a natural key, de-duplication inside one payload, and a second `--apply` must add 0 rows.
- **D8 Capture before you parse.** For an unknown external format, store the raw body first, inspect its structure, then write fixtures and the parser. Unknown shapes are skipped and counted, never guessed.
- **D9 Session-mode pooler connection.** Transaction-mode poolers hung simultaneous calls with the `postgres` driver's pipelining; the code switches Supabase's pooler port 6543 to 5432 (`src/core/db.ts`, guarded by `test/db-pooler.db.test.ts`).
- **D10 Not countable is never 0, and a different format is "not compared", never "worse".** Missing or incomparable data is left out and listed.
- **D11 Optional modules are a switch, not a plugin system.** `HUB_MODULES` lists the modules that are on (`src/core/modules.ts`). An off module registers no tools and its routes answer 404. To customize, change the code with your agent.

## Data sources

- **Oura (read-only, OAuth2).** `usercollection/*` GETs only. The refresh token is single use: two requests refreshing at once would invalidate each other, so refresh is serialized and the new token is saved before it is used. A collection Oura answers 401 for on your account is recorded as unavailable and retried weekly. Late uploads are handled by re-fetching the last 3 days. Heart rate is one timeline table (`hr_samples`), read through `src/core/hr/window.ts`; nights are stored as 5-minute points.
- **Hevy (optional).** Workouts and exercise templates are synced (backfill, then incremental by event). Writes (routines, finished class workouts, custom exercises) go through a write-ahead audit log, never retry, and are previewed first. Hevy silently drops fields an exercise type doesn't show, so values are mapped by exercise type (`src/core/classes/build.ts`).
- **Apple Health, via Health Auto Export.** The phone pushes JSON to `/api/ingest/apple-health`; the route stores the raw body, then a parser turns it into samples keyed by `(metric, start, source)`. Source names matter (Summarize drops them), so body readings use a separate automation with Summarize off. Units are stored as kg / kcal whatever the phone sends.
- **Labs.** From Apple Health's clinical-records export (FHIR) or logged from a PDF/photo through `log_lab_results` (preview first). Units are stored as reported; only glucose and cholesterol are converted, on read, and the answer says so. The same result listed by two systems merges at read time (`mergeSameDraw`); stored rows are never deleted. DEXA scans are lab results with a canonical name per number (`src/core/labs/dexa.ts`).
- **Optional "optimal ranges"** (`src/core/labs/ranges.ts`): a narrower band applied at read time, only when the LOINC code and unit scale match; the lab's own range stays beside it.

## Tools

Registered by area in `app/api/mcp/tools/`. Read tools are labelled read-only; write tools are not, so a connector puts them in an approval group.

- Core: `ping`, `sync_now`, `get_sync_status`, `get_trends`, `get_heart_rate`, `get_recovery`, `get_oura_data`, `connect_oura`, `get_body_metrics`, `list_health_types`, `get_health_data`, `exclude_apple_sample`, `get_lab_results`, `log_lab_results`.
- Hevy (needs `HEVY_API_KEY`): `get_recent_workouts`, `get_workout_details`, `get_exercise_progress`, `get_training_summary`, `search_exercises`, `create_routine`, `update_routine`.
- Modules: `checkins` (`log_checkin`, `get_checkins`, `get_feel_vs_ring`), `classes` (`log_class_workout`, `get_class_history`), `genetics` (`log_genetic_variants`, `get_genetics`), `events` (`log_event`).

Comparisons go through `src/core/compare/`: "vs last time" for any exercise (`compareExercise`), and board completion (`classCompletion`), computed when read and never stored.

## Schema

`supabase/migrations/0001_schema.sql` creates everything: workouts and sets, exercise templates, Oura documents and heart-rate samples, Apple samples and raw deliveries, lab results, genetic variants, morning check-ins, events, class sessions, a Hevy write audit log, sync state and settings. Add later changes as `0002_*.sql`.

## Testing

- Pure logic (units, estimates, parsing, timezones/DST, comparisons) is unit tested.
- Database tests run inside transactions that are always rolled back, with synthetic data dated 2031 and rows looked up by their own ids. They need `DATABASE_URL`; they skip without it.
- No test may reach Hevy or Oura: writers and clients are faked, with realistic latency.
- `test/mcp-route.test.ts` checks the tool list and safety labels; `test/modules.test.ts` checks every module setting; the Coach instructions are tested against the real tool list and for plain text.
- CI (`.github/workflows/ci.yml`) applies the schema to a Postgres container and runs `tsc` and the full tests.

## Reliability

- Every read tool answers within 25 s (`src/core/tools/run.ts`); outbound calls have timeouts; nothing runs "in the background" on the single database connection.
- Each call logs one `tool {...}` line with timings. Never log health values.
- If a call gets stuck, the server throws its connection away so the next call starts clean.

## Learnings worth keeping

- Live APIs differ from their docs: look at one real response before relying on a shape (`npm run docs:fetch` downloads the specs).
- A vendor setting can change what data means; read the help pages before choosing toggles.
- Mixing time grains double counts; one source is the truth per metric.
- Dashboards and click paths change: check current docs.
