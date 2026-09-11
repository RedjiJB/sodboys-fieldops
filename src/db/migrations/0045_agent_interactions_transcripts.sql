-- Reverses 0043_agent_interactions.sql's structured-paraphrase-only
-- design, by explicit instruction: full verbatim transcripts are wanted
-- for real IT-management chat review, not just a fine-tuning summary.
-- That migration's own header explained the original reasoning (privacy
-- surface, and structured data being more directly useful for a weekly
-- review) -- both still true, but no longer the constraint once the
-- owner has explicitly asked for full transcript access as a real IT
-- management requirement. Recorded here as a real, dated decision rather
-- than silently reversed: verbatim crew/bot message text now lives in
-- this table going forward (not retroactively -- rows logged before this
-- migration only ever had a paraphrase, nothing to backfill from).
ALTER TABLE agent_interactions
  ADD COLUMN crew_message TEXT,
  ADD COLUMN bot_reply    TEXT;
