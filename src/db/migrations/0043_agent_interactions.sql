-- Structured agent-interaction logging, built in response to a real gap:
-- OpenClaw retains no WhatsApp message content by design (channel_ingress_
-- events.payload_json is cleared after processing) and its bundled
-- command-logger hook only fires on Events: command (slash-commands), never
-- on ordinary chat -- confirmed live on the gateway box before this was
-- written, not assumed.
--
-- Deliberately structured, not verbatim: this table stores a short
-- agent-authored paraphrase of what happened, not the crew member's raw
-- message text. That's a real, considered choice, not a shortcut --
-- retaining verbatim WhatsApp content is a genuinely more sensitive data-
-- retention decision (this project's own sovereignty-tiering discipline
-- would apply if crew message content ever left this node, and arguably
-- even retaining it AT this node deserves its own explicit sign-off) that
-- wasn't asked for. A structured summary is also more directly useful for
-- the weekly fine-tuning review this exists to feed: "guard asked X, bot
-- resolved to tool Y, outcome Z" is already the shape a review needs,
-- rather than something a review has to first extract from prose.
--
-- crew_member_id is nullable: some interactions (an unresolved sender, a
-- misrouted message) genuinely have no resolved identity, and that's a
-- real, distinct state worth keeping rather than dropping the row.
CREATE TABLE agent_interactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          TEXT NOT NULL CHECK (channel IN ('whatsapp', 'dashboard_chat')),
  crew_member_id   UUID REFERENCES crew_members(id),
  summary          TEXT NOT NULL,
  tools_called     TEXT[] NOT NULL DEFAULT '{}',
  outcome          TEXT NOT NULL CHECK (outcome IN ('resolved', 'partial', 'failed', 'unresolved_sender')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_interactions_created_at_idx ON agent_interactions (created_at);
CREATE INDEX agent_interactions_crew_member_id_idx ON agent_interactions (crew_member_id);
