-- Admin MFA, closing a real backlog gap: admin accounts hold the highest-
-- blast-radius capabilities in the dashboard (Settings/AI-provider-key
-- changes, site budget, webhook targets) and had no second factor beyond
-- a password. TOTP (RFC 6238), not email/SMS-based, since no outbound-
-- email or SMS-sending infrastructure exists anywhere in this system yet
-- -- an authenticator-app secret needs neither.
--
-- totp_secret is the base32-encoded shared secret -- stored plain, same
-- posture this project already accepts for AI provider keys in
-- llm_settings (see that table's own migration) rather than a new
-- envelope-encryption mechanism invented just for this column; a real
-- KMS/encryption-at-rest pass, if it ever happens, should cover both
-- consistently, not one column in isolation.
--
-- totp_enabled is a separate boolean from "secret is set" on purpose:
-- enrollment writes a pending secret first, then a real verified code
-- flips totp_enabled -- so a half-finished enrollment (secret generated,
-- QR code never scanned) never silently gates login before the user has
-- confirmed their authenticator app actually works.
ALTER TABLE users
  ADD COLUMN totp_secret  TEXT,
  ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT false;
