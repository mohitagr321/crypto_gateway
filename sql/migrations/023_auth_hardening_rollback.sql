-- Rollback for 023_auth_hardening.sql
--
-- WHAT YOU LOSE, deliberately stated because both of these are security
-- controls and dropping them is not neutral:
--
--   * Dropping api_keys.signature_version returns every key to "accept v2 or
--     legacy v1". middleware/auth.ts already degrades to exactly that when the
--     column is absent (it catches undefined_column), so nothing breaks — but a
--     captured v1 signature becomes replayable against any other body-less
--     endpoint inside the 5-minute skew window again. Do NOT roll this back
--     while any key is set to 2 unless you accept that.
--
--   * Dropping refresh_tokens returns refresh to un-revocable. routes/auth.ts
--     degrades to issuing untracked tokens (it catches undefined_table), and it
--     still re-reads users.status and the role from the database on every
--     refresh — that half of the fix survives a rollback. What is lost is
--     rotation and reuse detection.
--
-- Every live refresh token stays VALID across this rollback: its row simply
-- stops being consulted, and the route treats an untracked token as pre-023.
-- Nobody is signed out. Restart the API after running this so the process
-- stops trying to select the dropped column/table on the first request.

BEGIN;

DROP TABLE IF EXISTS refresh_tokens;

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_signature_version_check;
ALTER TABLE api_keys DROP COLUMN IF EXISTS signature_version;

COMMIT;
