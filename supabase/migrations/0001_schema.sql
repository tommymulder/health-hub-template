-- Health Hub schema (the template ships ONE migration: the 13 steps of the original build, squashed, no data rows).
-- Every table has row level security ON and no policies: only the server-side connection (the database owner) can read or write.
-- The "revoke ... from anon, authenticated" lines run only where those Supabase roles exist (plain Postgres, as in CI, has none).
-- To change the schema later, add 0002_<name>.sql beside this file and apply it the same way.

-- ===== from 0001_init.sql =====
-- 0001_init.sql — Phase 2: bookkeeping + Hevy tables.
-- Later phases add their own migrations (classes, oura, apple, labs).
-- Every table has Row Level Security ON and NO policies: Supabase auto-exposes
-- tables through a public REST API, and RLS-with-no-policies locks that door.
-- The hub connects with the server-side Postgres connection string only.

create table sync_state (
  source      text primary key,          -- 'hevy_workouts' | 'hevy_backfill' | 'hevy_templates'
  cursor      text,                      -- ISO time, or backfill page number / 'done'
  last_run_at timestamptz,
  last_ok_at  timestamptz,
  last_error  text
);

create table settings (
  key text primary key, value text not null
);

create table exercise_templates (
  id text primary key, title text not null, type text,
  primary_muscle text, secondary_muscles jsonb, equipment text,
  is_custom boolean not null default false, updated_at timestamptz not null
);

create table workouts (
  id text primary key,
  title text, description text,
  start_at timestamptz not null, end_at timestamptz not null,
  local_date date not null,
  hevy_updated_at timestamptz,
  raw jsonb not null,
  deleted boolean not null default false
);
create index on workouts (start_at);

create table workout_exercises (
  id bigint generated always as identity primary key,
  workout_id text not null references workouts(id) on delete cascade,
  position int not null, exercise_template_id text, exercise_title text not null,
  superset_id int, notes text
);
create index on workout_exercises (workout_id);
create index on workout_exercises (exercise_template_id);

create table sets (
  id bigint generated always as identity primary key,
  workout_exercise_id bigint not null references workout_exercises(id) on delete cascade,
  position int not null, set_type text not null,
  weight_kg numeric, reps int, rpe numeric, duration_s int, distance_m numeric
);
create index on sets (workout_exercise_id);

create table hevy_writes (
  hevy_id text primary key,
  kind text not null,
  title text not null,
  created_at timestamptz not null default now(),
  request jsonb not null, response jsonb not null
);

alter table sync_state         enable row level security;
alter table settings           enable row level security;
alter table exercise_templates enable row level security;
alter table workouts           enable row level security;
alter table workout_exercises  enable row level security;
alter table sets               enable row level security;
alter table hevy_writes        enable row level security;

-- ===== from 0003_hevy_writes_audit.sql =====
-- 0003: hevy_writes becomes a true audit log (Hevy has no delete, so this is our undo record).
--  * many rows per Hevy object (the create, then every update)
--  * a write-ahead 'pending' row is inserted BEFORE each POST/PUT, then finalised
--  * the routine's previous state is kept before an overwrite
alter table hevy_writes drop constraint hevy_writes_pkey;
alter table hevy_writes add column id bigint generated always as identity primary key;
alter table hevy_writes add column action text not null default 'create';  -- 'create' | 'update'
alter table hevy_writes add column outcome text not null default 'ok';    -- 'pending' | 'ok' | 'unconfirmed' | 'rejected'
alter table hevy_writes add column previous jsonb;                        -- state before an update
alter table hevy_writes alter column response drop not null;              -- none yet while pending
create index hevy_writes_guard_idx on hevy_writes (kind, title, created_at);
create index hevy_writes_hevy_id_idx on hevy_writes (hevy_id);

-- ===== from 0004_oura.sql =====
-- 0004: Oura (Phase 5). RLS on every table, no policies (server-side connection only).

-- OAuth tokens. Oura refresh tokens are SINGLE-USE: every refresh returns a new
-- pair and kills the old one, so rows are only ever changed by a conditional UPDATE.
create table oauth_tokens (
  provider      text primary key,          -- 'oura'
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  scope         text,
  updated_at    timestamptz not null default now()
);

-- One-time OAuth `state` values: a random, single-use, short-lived token that ties an
-- authorization callback to a link WE issued (CSRF protection), so the public callback
-- route needs no shared secret and no secret ever travels in a URL.
create table oauth_states (
  state      text primary key,
  provider   text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

-- Every Oura document, lossless (DESIGN section 5: document-in-SQL).
create table oura_documents (
  collection text not null,
  id         text not null,
  day        date,
  start_at   timestamptz,
  end_at     timestamptz,
  data       jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (collection, id)
);
create index on oura_documents (collection, day);
create index on oura_documents (collection, start_at);

-- Heart-rate samples (irregular: seconds apart when active, minutes apart at rest).
create table hr_samples (
  ts     timestamptz not null,
  bpm    int not null,
  source text not null,                    -- 'oura:awake' | 'oura:workout' | 'oura:rest' | 'oura:sleep' ...
  primary key (ts, source)
);

alter table oauth_tokens    enable row level security;
alter table oauth_states    enable row level security;
alter table oura_documents  enable row level security;
alter table hr_samples      enable row level security;

-- ===== from 0005_classes.sql =====
-- 0005: class workouts (Phase 6). RLS on, no policies.
-- A class = lettered blocks (A, B, C, D), each block = movements done back to back.
create table class_sessions (
  id              bigint generated always as identity primary key,
  gym             text not null,
  class_type      text not null,           -- 'strength' | 'strength_hiit' | 'cardio_endurance' | 'mixed'
  title           text not null,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  window_source   text not null,           -- 'explicit' | 'oura_workout' | 'heart_rate' | 'photo_time'
  local_date      date not null,
  board_text      text not null,           -- Claude's full transcription of all photos
  planned         jsonb not null,          -- the structured board
  completion_pct  numeric,                 -- overall, 0-100
  precision       text not null,           -- 'exact' | 'partial' (some values assumed) | 'estimated' (from an overall %)
  user_notes      text,
  hevy_workout_id text,                    -- NO foreign key on purpose: Hevy's id can arrive before the workout row is synced
  created_at      timestamptz not null default now()
);
create index on class_sessions (start_at);
create index on class_sessions (hevy_workout_id);

create table class_blocks (
  id          bigint generated always as identity primary key,
  session_id  bigint not null references class_sessions(id) on delete cascade,
  label       text not null,
  format      text not null,               -- 'sets' | 'every_n_minutes' | 'emom' | 'amrap' | 'for_time' | 'intervals' | 'other'
  sets_min    int, sets_max int,
  interval_s  int, rounds int,
  time_cap_s  int,
  sets_done   numeric                      -- what was actually done
);
create index on class_blocks (session_id);

create table class_movements (
  id                   bigint generated always as identity primary key,
  block_id             bigint not null references class_blocks(id) on delete cascade,
  position             int not null,
  movement             text not null,      -- normalised: 'barbell bench press', 'pull up', 'plank' ...
  exercise_template_id text,               -- Hevy template used (same ones as gym lifts)
  target               jsonb not null,
  variant_done         text,               -- null = as written | 'RX' | 'scaled' | free text
  done_sets            jsonb,              -- [{"reps":8,"weight_lb":95},...] or [{"duration_s":60}]
  assumed              boolean not null default false
);
create index on class_movements (block_id);
create index on class_movements (movement);
create index on class_movements (exercise_template_id);

alter table class_sessions  enable row level security;
alter table class_blocks    enable row level security;
alter table class_movements enable row level security;

-- ===== from 0006_apple_health.sql =====
-- 0006: Apple Health (Phase 7). RLS on every table, no policies (server-side connection only).

-- Every push from Health Auto Export lands here first, untouched, so a parser bug
-- never loses data: fix the parser, re-run it over these rows. Kept 30 days.
create table raw_ingest (
  id           bigint generated always as identity primary key,
  source       text not null,               -- 'apple_health'
  received_at  timestamptz not null default now(),
  payload      jsonb not null,
  processed_at timestamptz,
  error        text
);
create index on raw_ingest (source, received_at);

-- Every Apple Health data point (minus Oura's own copies, D12).
create table apple_samples (
  metric   text not null,                   -- HAE metric name, e.g. 'weight_body_mass'
  start_at timestamptz not null,
  end_at   timestamptz,
  source   text not null default '',        -- 'a scale app', 'iPhone', ...
  value    double precision,                -- SI unit (kg, m, kcal, count, ...)
  min      double precision,
  max      double precision,                -- for Min/Avg/Max metrics
  unit     text,
  extra    jsonb,                           -- anything else in the data point
  hidden   boolean not null default false,  -- set by exclude_apple_sample
  primary key (metric, start_at, source)    -- natural key: HAE sends no HealthKit ids
);
create index on apple_samples (metric, start_at);

-- Workouts as Apple Health saw them (Hevy writes its workouts there too).
create table apple_workouts (
  id       text primary key,                -- HAE workout id, else hash(name,start,end,source)
  name     text,
  start_at timestamptz not null,
  end_at   timestamptz not null,
  source   text,
  data     jsonb not null,                  -- energy, distance, HR summaries, ...
  linked_workout_id text references workouts(id)
);
create index on apple_workouts (start_at);

alter table raw_ingest     enable row level security;
alter table apple_samples  enable row level security;
alter table apple_workouts enable row level security;

-- ===== from 0007_raw_ingest_headers.sql =====
-- 0007: keep HAE's descriptive request headers (automation-name, -aggregation, -period,
-- session-id) beside each raw body. Never the key: only a fixed allowlist is stored.
alter table raw_ingest add column headers jsonb;

-- ===== from 0008_labs.sql =====
-- 0008: lab results (Phase 8). RLS on, no policies (server-side connection only).
-- Original units are kept exactly as reported; nothing is converted on write.
create table lab_results (
  id            text primary key,          -- FHIR Observation id, or hash(test, collected_at, value, source)
  collected_at  timestamptz not null,      -- specimen collection time (else the issued date)
  test_name     text not null,             -- as reported, e.g. 'Cholesterol, Total'
  loinc_code    text,                      -- e.g. '2093-3'
  value_num     double precision,          -- numeric results
  value_text    text,                      -- non-numeric ('Negative', '<0.5')
  unit          text,                      -- original unit, never converted on write
  ref_low       double precision,
  ref_high      double precision,
  ref_text      text,                      -- e.g. '<200', 'Negative'
  flag          text,                      -- 'H' | 'L' | 'normal' | 'abnormal' | null
  panel         text,                      -- 'Lipid Panel', 'CBC', 'CMP', ...
  performer     text,                      -- lab / provider
  source        text not null,             -- 'apple_health_records' | 'claude_upload'
  raw           jsonb,                     -- full FHIR resource or extracted row
  imported_at   timestamptz not null default now()
);
create index on lab_results (loinc_code, collected_at);
create index on lab_results (test_name, collected_at);
alter table lab_results enable row level security;

-- ===== from 0009_genetics.sql =====
-- 0009: genetic variants (Phase 13). One row per tested variant.
-- Genotypes don't change, so they are not lab measurements.
-- RLS on, and the public API roles cannot touch the table (the hub uses the
-- direct database connection, same as every other table).
create table genetic_variants (
  id             bigint generated always as identity primary key,
  gene           text not null,
  variant        text not null,
  rsid           text check (rsid ~ '^rs[0-9]+$'),
  variant_copies smallint not null check (variant_copies between 0 and 2),
  reported_as    text not null,
  collected_at   date not null,
  reported_at    date,
  source         text not null,
  raw            jsonb,
  imported_at    timestamptz not null default now(),
  unique (gene, variant, collected_at, source)
);
alter table genetic_variants enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table genetic_variants from anon, authenticated; end if; end $$;
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on sequence genetic_variants_id_seq from anon, authenticated; end if; end $$;

-- ===== from 0010_morning_checkins.sql =====
-- 0010: morning check-ins (Phase 12). One row per Pacific wake-up date.
-- The Shortcut and Claude both upsert this row. Logging again the same day
-- replaces it. RLS on, and the public API roles cannot touch the table
-- (the hub uses the direct database connection, same as every other table).
create table morning_checkins (
  day         date primary key,
  rating      smallint not null check (rating between 1 and 5),
  note        text check (char_length(note) <= 500),
  logged_at   timestamptz not null,
  source      text not null check (source in ('shortcut', 'claude')),
  recalled    boolean not null default false,
  updated_at  timestamptz not null default now()
);
alter table morning_checkins enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table morning_checkins from anon, authenticated; end if; end $$;

-- ===== from 0011_events.sql =====
-- 0011: a log of timestamped events (Phase 17). The first type is `bathroom` (one Action Button press per trip, day
-- and night). Counts, nights and matches with the ring are computed when read, so this stores only the raw facts.
-- A new type is a one-line change to the check below. No deletes: a mis-press is hidden (reversible).
-- RLS on, and the public API roles cannot touch the table (the hub uses the direct database connection).
create table events (
  id          bigint generated always as identity primary key,
  type        text not null check (type in ('bathroom')),
  at          timestamptz not null,
  source      text not null check (source in ('shortcut', 'claude', 'button')),
  approximate boolean not null default false,
  note        text check (char_length(note) <= 200),
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index events_type_at_idx on events (type, at);
alter table events enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table events from anon, authenticated; end if; end $$;

-- ===== from 0012_class_notes.sql =====
-- 0012: class coaching notes (Phase 19). The note Claude writes from the hub's numbers is stored with the class
-- (it is also sent to Hevy as the workout description). RLS is already on for class_sessions. The other new class
-- inputs (total, share, optional, calories, finish_s) live in the existing jsonb columns and need no new columns.
alter table class_sessions add column coaching_note text check (char_length(coaching_note) <= 1500);

-- ===== from 0013_class_completion_excluded.sql =====
-- Phase 19 fix-up: a class whose board is not trustworthy (reconstructed from memory, no photo) can be left out of board
-- completion. The text is the reason; null = counted as usual. Hub only; nothing about the Hevy copy changes.
alter table class_sessions add column completion_excluded text check (char_length(completion_excluded) <= 200);

