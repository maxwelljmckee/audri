-- Slice 9 follow-up: account-tombstone flag.
--
-- Stored on user_settings (which already has user_id as PK + 1:1 with auth.users).
-- DELETE /me sets this column + revokes sessions; downstream auth checks reject
-- requests from tombstoned users. Hard delete + data export remain V1+.

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "tombstoned_at" timestamptz;
