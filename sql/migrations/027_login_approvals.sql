-- =============================================================================
-- LOGIN APPROVALS — every sign-in is confirmed from the account's own mailbox.
--
-- A correct password is no longer sufficient to obtain a session. It buys one
-- thing: a pending approval, and an email to the address on the account showing
-- WHERE the attempt came from. The session is issued only after the person
-- holding that mailbox says yes.
--
-- ---------------------------------------------------------------------------
-- TWO SECRETS, AND NEITHER ONE IS ENOUGH ON ITS OWN
--
-- This is the property the whole table is shaped around, so it is worth stating
-- before the columns:
--
--   action_hash     sha256 of the token that exists ONLY inside the emailed
--                   link. It grants the right to DECIDE — approve or reject —
--                   and nothing else. It cannot mint a session.
--
--   challenge_hash  sha256 of the token returned ONLY to the browser that
--                   submitted the correct password. It grants the right to
--                   COLLECT the session once the decision is "approved", and
--                   nothing else. It cannot approve anything.
--
-- So an attacker who reads the mailbox can approve a login but the tokens are
-- still delivered to whoever knew the password. An attacker who knows the
-- password cannot proceed without the mailbox. The session always lands in the
-- browser that authenticated, which is what makes the email a second factor
-- rather than a second password.
--
-- Both are stored as digests for the same reason `user_tokens.token_hash` and
-- `api_keys.token_hash` are: a database read must not be replayable into an
-- account takeover.
--
-- ---------------------------------------------------------------------------
-- WHY THE EMAIL LINK MUST NOT BE THE APPROVAL ITSELF
--
-- Mail providers and corporate filters FETCH the links in a message to scan
-- them. Gmail, Outlook and most security gateways do this within seconds of
-- delivery. A `GET /approve?token=…` that approved on sight would therefore be
-- auto-approved by a robot before the human ever opened the mail, which would
-- make this table a decoration.
--
-- The link in the email opens a PAGE in the panel. That page shows the device
-- details recorded below and requires a deliberate button press, which issues a
-- POST. Scanners follow GETs; they do not press buttons. The decision endpoints
-- are POST-only for exactly this reason — see routes/auth.ts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS login_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The two secrets. UNIQUE because each is looked up directly by digest.
  challenge_hash text NOT NULL,
  action_hash    text NOT NULL,

  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),

  -- ---------------------------------------------------------------------
  -- WHAT THE EMAIL SHOWS. Captured at the moment of the attempt, because it is
  -- the only evidence the account holder has to decide on. `user_agent` is kept
  -- raw as well as parsed: the parse is a best-effort convenience for the email
  -- body, and when someone is investigating a suspicious sign-in six months
  -- later the exact string is what settles it.
  -- ---------------------------------------------------------------------
  ip             text,
  user_agent     text,
  device_label   text,          -- "Chrome 141 on macOS"
  device_kind    text,          -- desktop | mobile | tablet | unknown
  panel          text,          -- merchant | admin — derived from ROLE, never from the request

  expires_at     timestamptz NOT NULL,
  decided_at     timestamptz,
  -- Recorded separately from `decided_at`: approving and collecting the session
  -- are two different moments, and the gap between them is interesting when
  -- something looks wrong.
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_login_approvals_challenge
  ON login_approvals (challenge_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_login_approvals_action
  ON login_approvals (action_hash);

-- The reaper's index, and the one the "is there already a live attempt?" check
-- uses when a merchant hits sign-in twice.
CREATE INDEX IF NOT EXISTS idx_login_approvals_open
  ON login_approvals (user_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_login_approvals_expiry
  ON login_approvals (expires_at)
  WHERE status = 'pending';

COMMENT ON TABLE login_approvals IS
  'One row per sign-in attempt that passed password (and MFA). The session is issued only after the account mailbox approves. action_hash decides; challenge_hash collects; neither is sufficient alone.';
