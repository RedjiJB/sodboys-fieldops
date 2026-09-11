-- Fixes the real, confirmed bug behind the "create_field_report fails
-- server-side: FK violation on field_reports_created_by_fkey even with
-- valid crew member IDs" alert (root-caused 2026-09-11, see the backlog
-- entry in docs/ARCHITECTURE.md): the MCP tool's `createdBy` parameter
-- accepted any UUID with no validation that it was specifically a
-- `users.id`, but 0040_field_reports.sql's own `created_by` column is a
-- FK to users(id) only. The WhatsApp bot resolves crew members, never
-- dashboard users -- it structurally cannot supply a real users.id, so
-- the fix isn't just "validate and reject," it's a real missing dual-
-- actor column, the same pattern this project already uses elsewhere
-- (e.g. purchase_orders' fulfilled-by handling): a field report can now
-- be authored by a dashboard user (created_by, unchanged) OR a crew
-- member submitting via WhatsApp (created_by_crew_member_id, new) --
-- never required to be one specific actor type.
ALTER TABLE field_reports
  ADD COLUMN created_by_crew_member_id UUID REFERENCES crew_members(id);
