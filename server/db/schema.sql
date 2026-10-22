-- Digital Legacy Manager — database schema
-- Run once against a fresh database (see server/README.md for setup).

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  email_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo               BOOLEAN NOT NULL DEFAULT FALSE,
  two_fa_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  login_alerts_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  biometric_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  inactivity_days       INTEGER NOT NULL DEFAULT 90,
  password_changed_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- One-time codes for signup verification, login verification, password reset
-- and 2FA setup. The plaintext code is never stored — only its SHA-256 hash —
-- so a database leak alone can't be used to log in as someone.
CREATE TABLE IF NOT EXISTS otp_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL CHECK (scope IN ('signup','login','reset','2fa_setup','beneficiary_verify')),
  -- Disambiguates multiple concurrent codes of the same scope for the same
  -- user — e.g. verifying two different beneficiaries' emails at once.
  -- NULL for scopes that only ever have one in-flight code per user.
  target_id    UUID,
  code_hash    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_user_scope_idx ON otp_codes (user_id, scope, target_id);

-- Every issued JWT carries this row's id as its "jti" claim. Signing out
-- deletes the row, and the auth middleware rejects any token whose session
-- no longer exists — real, server-side revocation instead of just deleting
-- a token client-side.
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device      TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  relationship  TEXT NOT NULL DEFAULT 'Not specified',
  contact       TEXT NOT NULL,
  trust         TEXT NOT NULL DEFAULT 'Secondary' CHECK (trust IN ('Primary','Secondary')),
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beneficiaries_user_idx ON beneficiaries (user_id);

CREATE TABLE IF NOT EXISTS assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  identifier      TEXT NOT NULL,
  beneficiary_id  UUID REFERENCES beneficiaries(id) ON DELETE SET NULL,
  action          TEXT NOT NULL DEFAULT 'Transfer to beneficiary',
  status          TEXT NOT NULL DEFAULT 'Active',
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_user_idx ON assets (user_id);

CREATE TABLE IF NOT EXISTS instructions (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                         TEXT NOT NULL,
  trigger_condition             TEXT NOT NULL,
  beneficiary_id                UUID REFERENCES beneficiaries(id) ON DELETE SET NULL,
  details                       TEXT NOT NULL DEFAULT '',
  status                        TEXT NOT NULL DEFAULT 'Draft',
  verification_status           TEXT NOT NULL DEFAULT 'not_started'
                                  CHECK (verification_status IN ('not_started','pending','approved','rejected')),
  verification_ref              TEXT,
  verification_simulated_days   INTEGER NOT NULL DEFAULT 0,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS instructions_user_idx ON instructions (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject             TEXT NOT NULL,
  to_beneficiary_id   UUID REFERENCES beneficiaries(id) ON DELETE SET NULL,
  condition           TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'Locked',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages (user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  detail   TEXT,
  status   TEXT NOT NULL DEFAULT 'info',
  ts       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, ts DESC);
