-- 0002_export_progress: resumable daily export (src/cron/export.ts). Expand-only: one new table, nothing existing changes.
-- A single row (id = 1) describes the export that is in progress: which Taipei day, which table, how far (rowid cursor),
-- the next part number, and the manifest pieces already finished. The row is deleted when _ok.json has been written.
--   attempt        1, or 2 after one restart because the head version moved while the export ran
--   lease_*        a cron invocation owns the export until lease_until (ms); a crashed invocation's lease just expires
CREATE TABLE export_progress (
  id               INTEGER PRIMARY KEY,
  day              TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  version_at_start INTEGER NOT NULL,
  epoch_at_start   TEXT NOT NULL,
  table_idx        INTEGER NOT NULL,
  rowid_cursor     INTEGER NOT NULL,
  part             INTEGER NOT NULL,
  rows             INTEGER NOT NULL,
  state            TEXT NOT NULL,
  lease_token      TEXT NOT NULL,
  lease_until      INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CONSTRAINT export_progress_single CHECK (id = 1),
  CONSTRAINT export_progress_attempt CHECK (attempt IN (1, 2)),
  CONSTRAINT export_progress_state_json CHECK (json_valid(state))
) STRICT;
