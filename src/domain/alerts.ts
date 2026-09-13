// Re-expressed from v1's alerts domain logic -- requirements baseline,
// not copied code. related_record_id is a bare, untyped UUID -- see
// 0025_alerts.sql for the full type->table mapping. Resolution is always
// a deliberate human action; nothing here auto-resolves on the underlying
// condition clearing (checkWeather in exceptions.ts is the one
// documented exception, since v1 gives weather alerts a unique
// date-scoped self-healing behavior).
import { pool } from "../db/pool.js";
import { createNotificationForAlert } from "./notifications.js";

export type AlertType =
  | "idle" | "delay" | "wrong_site" | "order_stalled" | "loadout_gap" | "overdue"
  | "vehicle_dark" | "weather" | "dashboard_unreachable" | "maintenance_due"
  | "backup_failed" | "cron_job_failed" | "connectivity_degraded" | "disk_space_low"
  | "it_issue" | "system_offline" | "crew_location_stale" | "crew_off_site";

export type AlertSeverity = "critical" | "routine";

// v1 only ever decided this transiently, in a Set living in its
// exceptions worker, never persisted on the alert row -- moved onto
// alerts.severity directly here (see 0025_alerts.sql's comment). Where
// v1's own requirements research didn't state an explicit verdict for a
// type, the judgment call is noted below.
const DEFAULT_SEVERITY: Record<AlertType, AlertSeverity> = {
  overdue: "critical",
  order_stalled: "critical",
  loadout_gap: "critical",
  delay: "critical",
  wrong_site: "critical", // not explicit in v1's research; grouped with the other real operational-deviation checks
  weather: "critical", // not explicit; the threshold itself already represents meaningful risk to a job happening today
  crew_off_site: "critical", // location/safety concern, per v1's it_escalation_roles routing
  crew_location_stale: "critical", // same
  dashboard_unreachable: "critical",
  backup_failed: "critical",
  cron_job_failed: "critical",
  connectivity_degraded: "critical",
  disk_space_low: "critical",
  it_issue: "critical",
  system_offline: "critical", // always raised pre-resolved (historical), but the severity value itself is still critical
  idle: "routine", // deliberately excluded from the critical set -- a rougher, lower-confidence proxy than the others
  maintenance_due: "routine", // a planning nudge, not an incident
  vehicle_dark: "routine", // overridable via notification_settings.vehicle_dark_critical
};

export type Alert = {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  site_id: string | null;
  related_record_id: string | null;
  raised_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_user_id: string | null;
};

export type RaiseAlertResult = { alert: Alert; created: boolean };

// Dedup: if relatedRecordId is provided and an unresolved alert of the
// same type already references it, that existing alert is returned
// (created: false) and no new notification is generated. A null
// relatedRecordId never dedups -- every call creates a fresh row, same
// as v1 (freeform reports like it_issue/system_offline).
export async function raiseAlert(args: {
  type: AlertType;
  summary: string;
  siteId?: string;
  relatedRecordId?: string;
  severityOverride?: AlertSeverity;
  recipientRolesOverride?: string[];
}): Promise<RaiseAlertResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (args.relatedRecordId) {
      const existing = await client.query(
        "SELECT * FROM alerts WHERE type = $1 AND related_record_id = $2 AND resolved_at IS NULL LIMIT 1",
        [args.type, args.relatedRecordId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { alert: existing.rows[0] as Alert, created: false };
      }
    }

    const severity = args.severityOverride ?? DEFAULT_SEVERITY[args.type];
    const alertRow = await client.query(
      `INSERT INTO alerts (type, severity, site_id, related_record_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [args.type, severity, args.siteId ?? null, args.relatedRecordId ?? null],
    );
    const alert = alertRow.rows[0] as Alert;

    await createNotificationForAlert(client, {
      alertId: alert.id,
      severity,
      summary: args.summary,
      recipientRolesOverride: args.recipientRolesOverride,
    });

    await client.query("COMMIT");
    return { alert, created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type ResolveAlertResult = { ok: true; alert: Alert } | { ok: false; reason: "not_found" | "already_resolved" };

// Resolving the underlying alert also acknowledges its notification --
// "the problem is actually fixed" is a strictly stronger signal than "a
// human has seen this and is on it", so it should carry that meaning
// forward rather than leaving the notification to keep escalating (up to
// max_escalations) or, if never delivered, showing up in every preview
// listing forever after the real problem is already gone. Acknowledgment
// and resolution stay separate concepts (see notifications.ts) -- this
// only makes resolution *also* satisfy acknowledgment, not the reverse.
export async function resolveAlert(id: string, resolver: { crewMemberId?: string; userId?: string }): Promise<ResolveAlertResult> {
  const current = await pool.query("SELECT * FROM alerts WHERE id = $1", [id]);
  const alert = current.rows[0] as Alert | undefined;
  if (!alert) return { ok: false, reason: "not_found" };
  if (alert.resolved_at) return { ok: false, reason: "already_resolved" };

  const result = await pool.query(
    `UPDATE alerts SET resolved_at = now(), resolved_by = $2, resolved_by_user_id = $3 WHERE id = $1 RETURNING *`,
    [id, resolver.crewMemberId ?? null, resolver.userId ?? null],
  );

  await pool.query(
    `UPDATE notifications SET acknowledged_at = now(), acknowledged_by = $2, acknowledged_by_user_id = $3
     WHERE source_type = 'alert' AND source_id = $1 AND acknowledged_at IS NULL`,
    [id, resolver.crewMemberId ?? null, resolver.userId ?? null],
  );

  return { ok: true, alert: result.rows[0] as Alert };
}

export async function listAlerts(filter?: { type?: AlertType; resolved?: boolean; siteId?: string }): Promise<Alert[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.type) {
    params.push(filter.type);
    conditions.push(`type = $${params.length}`);
  }
  if (filter?.resolved !== undefined) {
    conditions.push(filter.resolved ? "resolved_at IS NOT NULL" : "resolved_at IS NULL");
  }
  if (filter?.siteId) {
    params.push(filter.siteId);
    conditions.push(`site_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(`SELECT * FROM alerts ${where} ORDER BY raised_at DESC`, params);
  return result.rows as Alert[];
}

export async function getAlert(id: string): Promise<Alert | null> {
  const result = await pool.query("SELECT * FROM alerts WHERE id = $1", [id]);
  return (result.rows[0] as Alert) ?? null;
}

// Dashboard restoration: for the inbox/activity feeds' click-through.
// Only alert types whose related_record_id's table actually has a real
// façade page get a link -- see 0025_alerts.sql's type->table mapping
// for the full list. Several types point at tables with no page at all
// in this façade (checkouts, jobs, assets, shifts), and the self-
// monitoring types (backup_failed, it_issue, etc.) have no backing
// record to link to regardless -- those stay unlinked rather than
// guessing a destination.
const ALERT_TYPE_ROUTE: Partial<Record<AlertType, string>> = {
  idle: "/resources",
  crew_location_stale: "/resources",
  crew_off_site: "/resources",
  wrong_site: "/equipment",
  vehicle_dark: "/equipment",
  order_stalled: "/procurement",
  weather: "/map",
};

export function alertLinkForType(type: AlertType): string | null {
  return ALERT_TYPE_ROUTE[type] ?? null;
}
