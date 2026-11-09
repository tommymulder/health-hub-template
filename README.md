# Health Hub (template)

A small server that puts your **Oura ring, Apple Health, lab results and Hevy workouts** in one place, so an AI app (Claude, Cursor, Codex, or any app that speaks MCP) can answer questions like *"how recovered am I, and what should I train today?"* from your real numbers instead of guessing.

> **A suggested starting point.** Take it, change it, make it yours.

> **Not medical advice.** It reports your data and trends. It is not a doctor, and nothing it says is a diagnosis. Talk to a clinician about anything that worries you.

## What it looks like

> **You:** How am I doing this week?
> **Claude:** *(reads your recovery and trends)* Recovery: mixed, nothing to act on. HRV is up 12% on your own 60-night median (better), resting heart rate about the same. You trained 3 of 4 planned days. Weight is flat on the 7-day average. Last sync: 40 minutes ago.

> **You:** *(photo of a class board and a voice note)* Log this class.
> **Claude:** *(previews the whole workout, plus a short coaching note, and waits for your yes before sending it to Hevy)*

## What's inside

| Always on | Needs |
|---|---|
| **Oura**: sleep, readiness, HRV, heart rate, workouts, with your own 60-night baseline | Oura ring and your own Oura API app |
| **Apple Health** (via the Health Auto Export app): weight, body composition, activity | An iPhone and Health Auto Export Premium |
| **Labs**: import from Apple Health or read from a PDF/photo; trends, flags, DEXA scans | nothing extra |
| **Hevy** (optional, on when `HEVY_API_KEY` is set): lifting history, "vs last time" for any exercise, routines written back to Hevy | Hevy Pro |

**Optional modules**, off until you list them in `HUB_MODULES` (an off module has no tools and its web routes answer 404):

| Module | What it adds |
|---|---|
| `checkins` | A 1-5 "how did you wake up" rating from a phone Shortcut, compared with the ring (it says "too early" under 14 mornings) |
| `classes` | Log an instructor-led class from a photo of the board: planned vs done, completion over time, a coaching note as the Hevy description (needs Hevy) |
| `genetics` | Variants from a genetics report, with a short note only for variants you carry and a watch-list of related blood markers |
| `events` | A one-press phone button (the example is bathroom trips) read next to sleep and the ring's wake-ups |

## What you need, and what it costs

| Thing | Cost (check current pricing) |
|---|---|
| Supabase (database) | Free tier. **Unverified:** whether the daily sync keeps an idle free project from pausing; check Supabase's current rules |
| Vercel (hosting) | Hobby tier |
| A coding agent to set it up (Claude Code, Cursor or Codex) | Whatever your plan with it costs |
| An AI app that can add a custom MCP connector (for Claude: a paid plan) | Your plan |
| Oura ring + membership; Hevy Pro (optional); Health Auto Export Premium | Their prices |

## Quick start

1. Click **Use this template** on GitHub and make your copy **private**: it will hold your health data.
2. Open the folder in Claude Code, Cursor or Codex and say: *"Set this up for me by following AGENTS.md."*
3. The agent creates the database and the deployment (it asks before anything that costs money), and tells you the few steps only you can do: accounts, keys, the Oura app, the phone.

`AGENTS.md` is the setup guide and works for any agent. Run `npm run doctor` at any time to see what is and isn't set up (it prints pass/fail, never your keys).

## Read this before you connect Oura

Oura's API terms restrict storing Oura data and sending it to an AI service. Each person registers **their own** Oura app and decides for themselves whether their use is acceptable. Read Oura's terms yourself. The hub is single-user, uses your own keys, and keeps data in your own database.

## Safety

- Every database table has row level security on, with no public access; only the server's own connection reads data.
- The hub's key (`x-api-key`) is required for every tool call. The phone keys (`INGEST_KEY`, `CHECKIN_KEY`) each open only their own routes.
- Secrets live in `.env.local` (git-ignored) and in Vercel's environment variables. Never commit them.
- Writes to Hevy are permanent (Hevy has no delete), so every write tool previews first and asks for approval.

## Develop

```bash
cp .env.example .env.local   # fill in the values yourself
npm install
npm run dev                  # http://localhost:3000, MCP at /api/mcp
npm run doctor               # what is set up and what isn't
npm run test:fast            # quick tests, no database
npm test                     # everything; the database tests need DATABASE_URL and always roll back
npx tsc --noEmit
```

`DESIGN.md` explains how it is built and why. `docs/` holds the Coach instructions template and the phone-shortcut guide.

## License

MIT. See `LICENSE`.
