-- Leaderboard schema (Cloudflare D1 / SQLite).
--
--   wrangler d1 create dota2
--   npm run db:init
--
-- One database backs the whole site: sign-in is shared across every minigame,
-- and every run is tagged with the game it belongs to.
--
-- Only `players` is written to today. `runs` is here so its shape is settled
-- before anything depends on it; it stays empty until submissions land.

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

  -- Which minigame. Runs are never compared across games.
  game           TEXT NOT NULL,          -- e.g. 'pickthelock'

  -- The tick rate is baked into every trace, so a run recorded by one engine
  -- cannot be compared against, or re-verified by, another. Runs are only ever
  -- ranked within a single version.
  engine_version TEXT NOT NULL,

  -- A run is exactly these two fields, plus the game and engine. Everything
  -- below is derived by re-simulating them server-side; none of it is
  -- client-reported.
  seed           INTEGER NOT NULL,
  inputs         TEXT NOT NULL,

  -- Ranking is deliberately game-agnostic so one index and one query serve
  -- every leaderboard: `score` sorts descending, `tiebreak` ascending when
  -- scores are equal (misses, for pickthelock), and anything else a particular
  -- game wants to display goes in `stats` as JSON rather than as a column no
  -- other game will ever use.
  score          INTEGER NOT NULL,
  tiebreak       INTEGER NOT NULL DEFAULT 0,
  stats          TEXT,                   -- JSON: {captures, blues, won, ...}
  sim_ticks      INTEGER NOT NULL,

  verified       INTEGER NOT NULL DEFAULT 0,
  flags          TEXT,                   -- JSON array of anti-bot heuristic hits
  created_at     INTEGER NOT NULL
);

-- The leaderboard read: best verified, unflagged run per player, per game and
-- engine version. pickthelock scores are always a multiple of 1000, so ties
-- are common — break them on fewest misses, then on who got there first.
CREATE INDEX IF NOT EXISTS runs_leaderboard
  ON runs (game, engine_version, verified, score DESC, tiebreak ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS runs_by_player ON runs (steamid, game, score DESC);
