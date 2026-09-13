// Re-expressed from v1's notifications domain logic -- requirements
// baseline, not copied code. A single event log, not a per-recipient
// delivery table -- see 0027_notifications.sql. Delivery itself
// (WhatsApp via a host-side poller) is Phase 3 scope; what's built here
// is the mechanism a poller would call against: pending/escalation
// queries and the state transitions, not the poller process.
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { dispatchToWebhooks } from "./webhookTargets.js";
import { listCrewMembers, type CrewRole } from "./crewMembers.js";
import { getNotificationSettings } from "./notificationSettings.js";

export type NotificationPriority = "critical" | "routine";

export type Notification = {
  id: string;
  priority: NotificationPriority;
  message: string;
  source_type: string;
  source_id: string | null;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_by_user_id: string | null;
  whatsapp_message_id: string | null;
  escalated_count: number;
  last_escalated_at: string | null;
  send_attempts: number;
  recipient_roles_override: string[] | null;
};

// Called from within raiseAlert's transaction (see src/domain/alerts.ts)
// -- takes the shared client so an alert and its notification are always
// created atomically, never one without the other.
export async function createNotificationForAlert(
  client: PoolClient,
  args: { alertId: string; severity: NotificationPriority; summary: string; recipientRolesOverride?: string[] },
): Promise<Notification> {
  const result = await client.query(
    `INSERT INTO notifications (priority, message, source_type, source_id, recipient_roles_override)
     VALUES ($1, $2, 'alert', $3, $4) RETURNING *`,
    [args.severity, args.summary, args.alertId, args.recipientRolesOverride ?? null],
  );
  const notification = result.rows[0] as Notification;

  // Fire-and-forget, outside the transaction -- a slow/dead webhook
  // endpoint must never delay or fail the alert-creation commit. Errors
  // are swallowed here (dispatchToWebhooks already records failures on
  // the target row itself); a caller awaiting raiseAlert never blocks on
  // webhook delivery.
  void dispatchToWebhooks("notification.created", {
    id: notification.id,
    priority: notification.priority,
    message: notification.message,
    source_type: notification.source_type,
    source_id: notification.source_id,
    created_at: notification.created_at,
  }).catch(() => {});

  return notification;
}

// What the delivery poller pulls each cycle: critical, never delivered,
// not yet at the retry cap (send_attempts < 5, same as v1), and not
// acknowledged -- resolveAlert (see alerts.ts) acknowledges a
// notification the moment its underlying alert is fixed, so a
// not-yet-delivered preview whose real problem is already resolved
// shouldn't keep showing up here.
export async function listPendingNotifications(): Promise<Notification[]> {
  const result = await pool.query(
    `SELECT * FROM notifications WHERE priority = 'critical' AND delivered_at IS NULL AND acknowledged_at IS NULL AND send_attempts < 5 ORDER BY created_at`,
  );
  return result.rows as Notification[];
}

export type NotificationRecipient = { crewMemberId: string; name: string; phone: string };

// The real gap this closes: recipient_roles_override has always been a
// role LABEL ({owner}, {management,owner}), never resolved to an actual
// person a poller could message -- confirmed live before writing this
// that nothing in the system ever called listPendingNotifications outside
// of it being exposed as a tier-4 MCP tool with no agent polling it.
// users and crew_members are genuinely independent identities (no FK,
// same as everywhere else in this system) -- a dashboard role string like
// "owner" only becomes an actual WhatsApp-reachable person by matching
// against crew_members.role, which is the same convention by design (see
// registerUser's own role column comment), not a coincidence this
// function can rely on.
//
// A notification with no recipient_roles_override at all falls back to
// notification_settings.critical_notification_roles -- the same default
// every other role-scoped alert already uses (see raiseAlert's callers),
// so a poller never has to special-case "no override set."
export async function resolveNotificationRecipients(args: {
  priority: NotificationPriority;
  recipientRolesOverride: string[] | null;
}): Promise<NotificationRecipient[]> {
  let roles = args.recipientRolesOverride;
  if (!roles || roles.length === 0) {
    const settings = await getNotificationSettings();
    roles = args.priority === "critical" ? settings.critical_notification_roles : [];
  }
  if (!roles || roles.length === 0) return [];

  const members = await listCrewMembers({ roles: roles as CrewRole[], active: true });
  return members.map((m) => ({ crewMemberId: m.id, name: m.name, phone: m.phone }));
}

// The dashboard inbox view -- org-wide, not per-recipient (v1 has no
// per-recipient delivery tracking either, see 0027_notifications.sql's
// comment). Paginated, newest first.
export async function listNotifications(filter: { limit: number; offset: number; acknowledged?: boolean }): Promise<{ items: Notification[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.acknowledged !== undefined) {
    conditions.push(filter.acknowledged ? "acknowledged_at IS NOT NULL" : "acknowledged_at IS NULL");
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query(`SELECT count(*) FROM notifications ${where}`, params);
  const total = Number(countResult.rows[0].count);

  params.push(filter.limit, filter.offset);
  const itemsResult = await pool.query(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: itemsResult.rows as Notification[], total };
}

export async function countUnacknowledgedNotifications(): Promise<number> {
  const result = await pool.query("SELECT count(*) FROM notifications WHERE acknowledged_at IS NULL");
  return Number(result.rows[0].count);
}

// Always called on every delivery attempt, success or failure -- a
// separate call from markDelivered so a delivery-marking failure doesn't
// erase the attempt count, same as v1.
export async function markNotificationAttempted(id: string): Promise<void> {
  await pool.query("UPDATE notifications SET send_attempts = send_attempts + 1 WHERE id = $1", [id]);
}

export async function markNotificationDelivered(id: string, whatsappMessageId?: string): Promise<Notification | null> {
  const result = await pool.query(
    "UPDATE notifications SET delivered_at = now(), whatsapp_message_id = $2 WHERE id = $1 RETURNING *",
    [id, whatsappMessageId ?? null],
  );
  return (result.rows[0] as Notification) ?? null;
}

// The escalation poller's own query: critical, delivered, still
// unacknowledged, under the escalation cap, and due for another page --
// flat re-paging of the same recipient set, no tiered escalation, same
// as v1.
export async function listEscalationCandidates(escalationThresholdMinutes: number, maxEscalations: number): Promise<Notification[]> {
  const result = await pool.query(
    `SELECT * FROM notifications
     WHERE priority = 'critical' AND delivered_at IS NOT NULL AND acknowledged_at IS NULL
       AND escalated_count < $2
       AND COALESCE(last_escalated_at, delivered_at) < now() - ($1 || ' minutes')::interval
     ORDER BY created_at`,
    [escalationThresholdMinutes, maxEscalations],
  );
  return result.rows as Notification[];
}

export async function escalateNotification(id: string): Promise<Notification | null> {
  const result = await pool.query(
    "UPDATE notifications SET escalated_count = escalated_count + 1, last_escalated_at = now() WHERE id = $1 RETURNING *",
    [id],
  );
  return (result.rows[0] as Notification) ?? null;
}

// A separate, first-class concept from alerts.resolveAlert -- "a human
// has seen this and is on it" vs. "the underlying problem is actually
// fixed." Same distinction v1 draws.
export type AcknowledgeNotificationResult = { ok: true; notification: Notification } | { ok: false; reason: "not_found" | "already_acknowledged" };

export async function acknowledgeNotification(id: string, acknowledger: { crewMemberId?: string; userId?: string }): Promise<AcknowledgeNotificationResult> {
  const current = await pool.query("SELECT * FROM notifications WHERE id = $1", [id]);
  const notification = current.rows[0] as Notification | undefined;
  if (!notification) return { ok: false, reason: "not_found" };
  if (notification.acknowledged_at) return { ok: false, reason: "already_acknowledged" };

  const result = await pool.query(
    "UPDATE notifications SET acknowledged_at = now(), acknowledged_by = $2, acknowledged_by_user_id = $3 WHERE id = $1 RETURNING *",
    [id, acknowledger.crewMemberId ?? null, acknowledger.userId ?? null],
  );
  return { ok: true, notification: result.rows[0] as Notification };
}
