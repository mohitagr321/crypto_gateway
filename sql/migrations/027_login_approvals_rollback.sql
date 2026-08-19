-- Rollback for 027_login_approvals.sql.
--
-- Dropping the table disables the feature's storage but NOT the code path:
-- routes/auth.ts must also be running with LOGIN_APPROVAL_ENABLED=false, or
-- every sign-in will fail on a missing relation. Turn the flag off first, then
-- run this.
DROP TABLE IF EXISTS login_approvals;
