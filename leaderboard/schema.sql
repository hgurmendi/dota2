-- Leaderboard schema (Cloudflare D1 / SQLite). See issue #2.
--
--   wrangler d1 create pickthelock
--   wrangler d1 execute pickthelock --file=leaderboard/schema.sql
--
-- Phase 1 uses `players` only. `runs` is here so the shape is settled before
-- anything writes to it; it stays empty until submissions land in phase 2.

CREATE TABLE IF NOT EXISTS players (
  steamid     TEXT PRIMARY KEY,          -- 17-digit steamid64
  persona     TEXT NOT NULL DEFAULT '',
  avatar      TEXT NOT NULL DEFAULT '',
  banned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  steamid        TEXT NOT NULL REFERENCES players(steamid),

  -- The tick rate is baked into every trace, so a run recorded by one engine
  -- cannot be compared against, or re-verified by, another. Runs are only ever
  -- ranked within a single version.
  engine_version TEXT NOT NULL,

  -- A run is exactly these two fields plus the engine. Everything below is
  -- derived by re-simulating them server-side; none of it is client-reported.
  seed           INTEGER NOT NULL,
  inputs         TEXT NOT NULL,

  score          INTEGER NOT NULL,
  captures       INTEGER NOT NULL,
  misses         INTEGER NOT NULL,
  sim_ticks      INTEGER NOT NULL,
  won            INTEGER NOT NULL DEFAULT 0,

  verified       INTEGER NOT NULL DEFAULT 0,
  flags          TEXT,                   -- JSON array of anti-bot heuristic hits
  created_at     INTEGER NOT NULL
);

-- The leaderboard read: best verified, unflagged run per player. Score is
-- always a multiple of 1000 so ties are common; break them on fewest misses,
-- then on who got there first.
CREATE INDEX IF NOT EXISTS runs_leaderboard
  ON runs (engine_version, verified, score DESC, misses ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS runs_by_player ON runs (steamid, score DESC);
