-- 0001_init: food-log v2 D1 schema (plan 3.3, PRD 6).
--   sync core        meta / cas_guard / sync_clients / mutation_outcomes
--   business tables  stores / items / logs / weights / favorites / config   (all synced: user_id, version, deleted_at, updated_at)
--   login            login_codes
--   Better Auth      user / session / account / verification / passkey / apikey
-- Hand written: drizzle-kit cannot express STRICT or CHECK. EVERY table is STRICT.
-- Migration rule: expand -> contract only (plan 3.3).
--
-- D1 notes learned in the phase-0 spike (docs/plans/v2-spike.md):
--   * GLOB / LIKE patterns are limited to 50 bytes, so formats are checked with date() / strftime().
--   * CHECK passes on NULL, and date('garbage') is NULL, hence every date check carries an explicit IS NOT NULL.
--   * ids are client generated: every primary key is (user_id, id) so two users can never collide.

-- ---------------------------------------------------------------- sync core

-- version: global counter bumped once per committed mutation (CAS-guarded, plan 0.1)
-- epoch:   changes when the data is restored from backup / re-imported -> clients reset
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value ANY NOT NULL
) STRICT;
INSERT INTO meta (key, value) VALUES ('version', 0), ('epoch', 'e1');

-- D1 has no interactive transactions. Every commit batch starts with
--   INSERT INTO cas_guard(ok) SELECT CASE WHEN <state unchanged> THEN 1 ELSE 0 END
-- A stale read makes ok = 0, the CHECK fails and the whole batch rolls back. The table is emptied again in the same batch.
CREATE TABLE cas_guard (
  ok INTEGER NOT NULL,
  CONSTRAINT cas_ok CHECK (ok = 1)
) STRICT;

-- per-device idempotency cursor
CREATE TABLE sync_clients (
  user_id          TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  last_mutation_id INTEGER NOT NULL,
  last_seen_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id)
) STRICT;

-- What was answered for each processed mutation, so a lost-response replay gets the ORIGINAL answer:
--   ok = 1  the mutator's result (JSON in `result`); only the newest 200 per device are kept (pruned in the commit batch)
--   ok = 0  the business error (error / message / details); kept, never pruned, and handed back to the device on pull
--           (exception: `bot:*` clients are never pulled, so their rows, ok or error, share the newest-200 window)
CREATE TABLE mutation_outcomes (
  user_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  mutation_id INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  name        TEXT NOT NULL,
  result      TEXT,
  error       TEXT,
  message     TEXT,
  details     TEXT,
  at          TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id, mutation_id),
  CONSTRAINT mutation_outcomes_ok CHECK (ok IN (0, 1)),
  CONSTRAINT mutation_outcomes_shape CHECK (ok = 1 OR (error IS NOT NULL AND message IS NOT NULL))
) STRICT;

-- ---------------------------------------------------------------- stores
CREATE TABLE stores (
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- normName(name): NFKC, lower case, no whitespace / punctuation
  name_norm     TEXT NOT NULL,
  last_eaten_at TEXT,
  created_by    TEXT NOT NULL,
  ts            TEXT NOT NULL,
  version       INTEGER NOT NULL,
  deleted_at    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CONSTRAINT stores_id_prefix CHECK (substr(id, 1, 2) = 's:'),
  CONSTRAINT stores_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT stores_created_by CHECK (created_by IN ('app', 'kyujin'))
) STRICT;
-- at most one live store per normalised name (duplicate_name is checked by the mutator, the index is the last line of defence)
CREATE UNIQUE INDEX stores_user_norm_live ON stores (user_id, name_norm) WHERE deleted_at IS NULL;
CREATE INDEX stores_user_version ON stores (user_id, version);

-- ---------------------------------------------------------------- items (official fm: / 711: items are NOT in D1)
CREATE TABLE items (
  id         TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  base_id    TEXT,
  src        TEXT NOT NULL,
  name       TEXT NOT NULL,
  serving    TEXT NOT NULL,
  serving_g  REAL,
  kcal       REAL NOT NULL,
  protein    REAL NOT NULL,
  fat        REAL NOT NULL,
  carb       REAL NOT NULL,
  store_id   TEXT,
  created_by TEXT NOT NULL,
  ts         TEXT NOT NULL,
  -- set when the item was deleted because its store was deleted; stores.restore only restores these
  cascade_of TEXT,
  version    INTEGER NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CONSTRAINT items_kind CHECK (kind IN ('自建', '補填')),
  CONSTRAINT items_src CHECK (src IN ('7-11', '全家', '其他')),
  CONSTRAINT items_created_by CHECK (created_by IN ('app', 'kyujin')),
  -- ov: override of an official item (kind=補填, base_id = the official id) or u: user item (kind=自建, no base_id)
  CONSTRAINT items_id_rules CHECK (
    (substr(id, 1, 3) = 'ov:' AND kind = '補填' AND base_id IS NOT NULL AND base_id = substr(id, 4) AND length(id) > 3)
    OR (substr(id, 1, 2) = 'u:' AND kind = '自建' AND base_id IS NULL AND length(id) > 2)
  ),
  -- a store item is always src = 其他
  CONSTRAINT items_store_src CHECK (store_id IS NULL OR src = '其他'),
  CONSTRAINT items_name_not_blank CHECK (length(name) > 0 AND length(serving) > 0),
  CONSTRAINT items_serving_g CHECK (serving_g IS NULL OR serving_g > 0),
  CONSTRAINT items_nutrition CHECK (kcal >= 0 AND protein >= 0 AND fat >= 0 AND carb >= 0)
) STRICT;
CREATE INDEX items_user_version ON items (user_id, version);
CREATE INDEX items_user_store ON items (user_id, store_id) WHERE store_id IS NOT NULL;

-- ---------------------------------------------------------------- logs
CREATE TABLE logs (
  id         TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  ts         TEXT NOT NULL,
  -- NULL = quick log (or a Kyujin estimate): no item
  item_id    TEXT,
  name       TEXT NOT NULL,
  src        TEXT NOT NULL,
  qty        REAL NOT NULL,
  grams      REAL,
  kcal       REAL NOT NULL,
  protein    REAL NOT NULL,
  fat        REAL NOT NULL,
  carb       REAL NOT NULL,
  source     TEXT NOT NULL,
  store_id   TEXT,
  version    INTEGER NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  -- day is the Taipei day of ts; ts is the canonical "YYYY-MM-DDTHH:MM:SS+08:00"
  CONSTRAINT logs_day_is_taipei_day CHECK (date(ts, '+8 hours') IS NOT NULL AND day = date(ts, '+8 hours')),
  CONSTRAINT logs_ts_canonical CHECK (strftime('%Y-%m-%dT%H:%M:%S', ts, '+8 hours') IS NOT NULL AND ts = strftime('%Y-%m-%dT%H:%M:%S', ts, '+8 hours') || '+08:00'),
  CONSTRAINT logs_src CHECK (src IN ('7-11', '全家', '其他')),
  CONSTRAINT logs_source CHECK (source IN ('app', 'quick', 'kyujin')),
  -- no item => quick-log shape: qty = 1, no grams, src = 其他, no store
  CONSTRAINT logs_quick_shape CHECK (item_id IS NOT NULL OR (qty = 1 AND grams IS NULL AND src = '其他' AND store_id IS NULL)),
  CONSTRAINT logs_qty CHECK (qty > 0),
  CONSTRAINT logs_grams CHECK (grams IS NULL OR grams > 0),
  CONSTRAINT logs_nutrition CHECK (kcal >= 0 AND protein >= 0 AND fat >= 0 AND carb >= 0)
) STRICT;
CREATE INDEX logs_user_day ON logs (user_id, day);
CREATE INDEX logs_user_version ON logs (user_id, version);

-- ---------------------------------------------------------------- weights
CREATE TABLE weights (
  id         TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  ts         TEXT NOT NULL,
  kg         REAL NOT NULL,
  version    INTEGER NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CONSTRAINT weights_day_is_taipei_day CHECK (date(ts, '+8 hours') IS NOT NULL AND day = date(ts, '+8 hours')),
  CONSTRAINT weights_ts_canonical CHECK (strftime('%Y-%m-%dT%H:%M:%S', ts, '+8 hours') IS NOT NULL AND ts = strftime('%Y-%m-%dT%H:%M:%S', ts, '+8 hours') || '+08:00'),
  CONSTRAINT weights_kg_range CHECK (kg >= 30 AND kg <= 250),
  CONSTRAINT weights_kg_one_decimal CHECK (round(kg, 1) = kg)
) STRICT;
-- at most one live (undeleted) weight per user per day, enforced by the database
CREATE UNIQUE INDEX weights_user_day_live ON weights (user_id, day) WHERE deleted_at IS NULL;
CREATE INDEX weights_user_version ON weights (user_id, version);

-- ---------------------------------------------------------------- favorites (replaces Config.fav_ids and items.fav)
-- Un-favouriting sets deleted_at (a tombstone) so pull can carry it.
CREATE TABLE favorites (
  user_id    TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
) STRICT;
CREATE INDEX favorites_user_version ON favorites (user_id, version);

-- ---------------------------------------------------------------- config (one typed row per user)
CREATE TABLE config (
  user_id            TEXT NOT NULL PRIMARY KEY,
  target_kcal        INTEGER NOT NULL,
  target_protein     REAL NOT NULL,
  target_fat         REAL NOT NULL,
  target_carb        REAL NOT NULL,
  tdee               INTEGER,
  -- JSON array of "HH:mm" strings
  remind_meal_times  TEXT NOT NULL,
  remind_weight_time TEXT,
  version            INTEGER NOT NULL,
  deleted_at         TEXT,
  updated_at         TEXT NOT NULL,
  CONSTRAINT config_targets CHECK (target_kcal >= 0 AND target_protein >= 0 AND target_fat >= 0 AND target_carb >= 0),
  CONSTRAINT config_tdee CHECK (tdee IS NULL OR tdee >= 0),
  CONSTRAINT config_remind_meal_times CHECK (json_valid(remind_meal_times) AND json_type(remind_meal_times) = 'array')
) STRICT;
CREATE INDEX config_user_version ON config (user_id, version);

-- ---------------------------------------------------------------- login codes
-- Only the SHA-256 hash of the code is stored. Redeeming is one atomic
-- UPDATE ... WHERE used_at IS NULL AND expires_at > now ... RETURNING user_id.
CREATE TABLE login_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------- Better Auth (1.7.10 + @better-auth/passkey + @better-auth/api-key)
-- Dates are epoch milliseconds (drizzle integer mode "timestamp_ms"), booleans are 0/1.
CREATE TABLE user (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE session (
  id         TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id    TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE
) STRICT;
CREATE INDEX session_user_id_idx ON session (user_id);

CREATE TABLE account (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL,
  provider_id              TEXT NOT NULL,
  user_id                  TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  INTEGER,
  refresh_token_expires_at INTEGER,
  scope                    TEXT,
  password                 TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
) STRICT;
CREATE INDEX account_user_id_idx ON account (user_id);

CREATE TABLE verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX verification_identifier_idx ON verification (identifier);

CREATE TABLE passkey (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  public_key    TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  counter       INTEGER NOT NULL,
  device_type   TEXT NOT NULL,
  backed_up     INTEGER NOT NULL,
  transports    TEXT,
  created_at    INTEGER,
  aaguid        TEXT
) STRICT;
CREATE INDEX passkey_user_id_idx ON passkey (user_id);
CREATE INDEX passkey_credential_id_idx ON passkey (credential_id);

-- Bot API keys (Kyujin). `key` is base64url(SHA-256(plaintext)); the plaintext is never stored.
--   permissions  JSON {"foodlog":["read","write.kyujin"]}
--   metadata     JSON {"actor":"kyujin"}
-- reference_id is the owning user (the single owner): bot requests are scoped to that user's data.
CREATE TABLE apikey (
  id                    TEXT PRIMARY KEY,
  config_id             TEXT NOT NULL DEFAULT 'default',
  name                  TEXT,
  start                 TEXT,
  reference_id          TEXT NOT NULL,
  prefix                TEXT,
  key                   TEXT NOT NULL,
  refill_interval       INTEGER,
  refill_amount         INTEGER,
  last_refill_at        INTEGER,
  enabled               INTEGER NOT NULL DEFAULT 1,
  rate_limit_enabled    INTEGER NOT NULL DEFAULT 0,
  rate_limit_time_window INTEGER,
  rate_limit_max        INTEGER,
  request_count         INTEGER NOT NULL DEFAULT 0,
  remaining             INTEGER,
  last_request          INTEGER,
  expires_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  permissions           TEXT,
  metadata              TEXT
) STRICT;
CREATE INDEX apikey_config_id_idx ON apikey (config_id);
CREATE INDEX apikey_reference_id_idx ON apikey (reference_id);
CREATE INDEX apikey_key_idx ON apikey (key);
