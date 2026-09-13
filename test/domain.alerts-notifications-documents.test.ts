// Phase 2 slice 5 verification: alerts, notifications, notification
// settings, the exceptions worker's check functions, system
// self-monitoring, and documents -- re-expressed from v1's fieldops-system
// as the requirements baseline (not copied code). Focuses on the
// load-bearing rules: raiseAlert's dedup (and that it atomically creates
// a notification, never one without the other), the escalation/delivery
// state machine, weather's unique date-scoped self-healing behavior, the
// fixed-sentinel-id pattern for tableless self-monitoring conditions, and
// the upload security properties (MIME allowlist, random storage
// filenames).
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { registerSite } from "../src/domain/sites.js";
import { registerCrewMember } from "../src/domain/crewMembers.js";
import { assignShift, confirmShift } from "../src/domain/shifts.js";
import { listJobTypes } from "../src/domain/jobTypes.js";
import { createJob } from "../src/domain/jobs.js";
import { registerAsset } from "../src/domain/assets.js";
import { createCheckout } from "../src/domain/checkouts.js";
import { createOrder } from "../src/domain/orders.js";
import { createLoadout, addLoadoutItem } from "../src/domain/loadouts.js";
import { listAlerts, raiseAlert, resolveAlert } from "../src/domain/alerts.js";
import {
  acknowledgeNotification,
  escalateNotification,
  listEscalationCandidates,
  listPendingNotifications,
  markNotificationAttempted,
  markNotificationDelivered,
} from "../src/domain/notifications.js";
import { getNotificationSettings, updateNotificationSettings } from "../src/domain/notificationSettings.js";
import {
  checkLoadoutGap,
  checkMaintenanceDue,
  checkOverdueCheckouts,
  checkStalledOrders,
  checkWeather,
} from "../src/domain/exceptions.js";
import {
  checkBackupStale,
  reportBackupStatus,
  reportConnectivityHealth,
  reportDiskHealth,
  reportOfflineRecovery,
} from "../src/domain/systemHealth.js";
import { classifyDocument, listExpiringDocuments, readDocumentFile, registerDocument, uploadDocument } from "../src/domain/documents.js";
import { registerUser } from "../src/domain/users.js";

process.env.UPLOAD_DIR = path.join(os.tmpdir(), "dcentral-fieldops-test-uploads");

let siteId: string;
let crewId: string;
let userId: string;
let userDid: string;
const createdCrewIds: string[] = [];
const createdCrewDids: string[] = [];
const createdSiteIds: string[] = [];
const createdAssetIds: string[] = [];
const createdCheckoutIds: string[] = [];
const createdOrderIds: string[] = [];
const createdJobIds: string[] = [];
const createdShiftIds: string[] = [];
const createdLoadoutIds: string[] = [];
const createdAlertIds: string[] = [];
const createdNotificationIds: string[] = [];
const createdDocumentIds: string[] = [];

beforeAll(async () => {
  const site = await registerSite({ name: "QA Alerts Site", type: "job_site", centerLat: 45.4215, centerLng: -75.6972, geofenceRadiusM: 100 });
  siteId = site.id;
  createdSiteIds.push(site.id);

  const crew = await registerCrewMember({ name: "QA Alerts Crew", phone: "+15559991001" });
  crewId = crew.id;
  createdCrewIds.push(crew.id);
  createdCrewDids.push(crew.did);

  const user = await registerUser({ email: "qa-alerts-admin@example.test", name: "QA Alerts Admin", password: "correct-password-123", role: "admin" });
  userId = user.id;
  userDid = user.did;
});

afterAll(async () => {
  await pool.query("DELETE FROM documents WHERE id = ANY($1)", [createdDocumentIds]);
  await pool.query("DELETE FROM loadout_items WHERE loadout_id = ANY($1)", [createdLoadoutIds]);
  await pool.query("DELETE FROM loadouts WHERE id = ANY($1)", [createdLoadoutIds]);
  await pool.query("DELETE FROM checkouts WHERE id = ANY($1)", [createdCheckoutIds]);
  await pool.query("DELETE FROM order_items WHERE order_id = ANY($1)", [createdOrderIds]);
  await pool.query("DELETE FROM orders WHERE id = ANY($1)", [createdOrderIds]);
  await pool.query("DELETE FROM shifts WHERE id = ANY($1)", [createdShiftIds]);
  await pool.query("DELETE FROM jobs WHERE id = ANY($1)", [createdJobIds]);
  await pool.query("DELETE FROM assets WHERE id = ANY($1)", [createdAssetIds]);
  await pool.query("DELETE FROM notifications WHERE id = ANY($1) OR source_id = ANY($2)", [createdNotificationIds, createdAlertIds]);
  await pool.query("DELETE FROM alerts WHERE id = ANY($1)", [createdAlertIds]);
  await pool.query("DELETE FROM sites WHERE id = ANY($1)", [createdSiteIds]);
  await pool.query("DELETE FROM capability_grants WHERE subject_did = $1", [userDid]);
  await pool.query("DELETE FROM verifiable_credentials WHERE subject_did = $1", [userDid]);
  await pool.query("DELETE FROM keys WHERE did = $1", [userDid]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM capability_grants WHERE subject_did = ANY($1)", [createdCrewDids]);
  await pool.query("DELETE FROM verifiable_credentials WHERE subject_did = ANY($1)", [createdCrewDids]);
  await pool.query("DELETE FROM keys WHERE did = ANY($1)", [createdCrewDids]);
  await pool.query("DELETE FROM crew_members WHERE id = ANY($1)", [createdCrewIds]);
  await rm(process.env.UPLOAD_DIR!, { recursive: true, force: true });
  await pool.end();
});

describe("alerts", () => {
  it("raiseAlert creates a notification atomically -- never one without the other", async () => {
    const asset = await registerAsset({ name: "QA Alert Test Asset" });
    createdAssetIds.push(asset.id);

    const { alert, created } = await raiseAlert({ type: "maintenance_due", relatedRecordId: asset.id, summary: "test maintenance alert" });
    createdAlertIds.push(alert.id);
    expect(created).toBe(true);
    expect(alert.severity).toBe("routine");

    const notification = await pool.query("SELECT * FROM notifications WHERE source_id = $1", [alert.id]);
    expect(notification.rowCount).toBe(1);
    expect(notification.rows[0].priority).toBe("routine");
    expect(notification.rows[0].message).toBe("test maintenance alert");
  });

  it("dedups against an already-open alert for the same type+related record, but not once resolved", async () => {
    const asset = await registerAsset({ name: "QA Dedup Test Asset" });
    createdAssetIds.push(asset.id);

    const first = await raiseAlert({ type: "maintenance_due", relatedRecordId: asset.id, summary: "first" });
    createdAlertIds.push(first.alert.id);
    const second = await raiseAlert({ type: "maintenance_due", relatedRecordId: asset.id, summary: "second (should dedup)" });
    expect(second.created).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);

    await resolveAlert(first.alert.id, { crewMemberId: crewId });
    const third = await raiseAlert({ type: "maintenance_due", relatedRecordId: asset.id, summary: "third (after resolve)" });
    createdAlertIds.push(third.alert.id);
    expect(third.created).toBe(true);
    expect(third.alert.id).not.toBe(first.alert.id);
  });

  it("resolveAlert denies an already-resolved or nonexistent alert", async () => {
    const { alert } = await raiseAlert({ type: "idle", relatedRecordId: crewId, summary: "idle test" });
    createdAlertIds.push(alert.id);

    const first = await resolveAlert(alert.id, { crewMemberId: crewId });
    expect(first.ok).toBe(true);
    const second = await resolveAlert(alert.id, { crewMemberId: crewId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_resolved");

    const missing = await resolveAlert("00000000-0000-0000-0000-000000000000", { crewMemberId: crewId });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");
  });

  it("a dashboard user can resolve an alert too -- resolved_by_user_id set, resolved_by left null", async () => {
    const { alert } = await raiseAlert({ type: "idle", relatedRecordId: crewId, summary: "idle test, dashboard resolve" });
    createdAlertIds.push(alert.id);

    const result = await resolveAlert(alert.id, { userId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alert.resolved_by_user_id).toBe(userId);
    expect(result.alert.resolved_by).toBeNull();
  });

  it("resolving an alert acknowledges its notification and pulls it out of listPendingNotifications", async () => {
    const { alert } = await raiseAlert({ type: "it_issue", summary: "QA resolve-acknowledges-notification test" });
    createdAlertIds.push(alert.id);

    const beforeIds = (await listPendingNotifications()).map((n) => n.id);
    const notificationRow = await pool.query("SELECT * FROM notifications WHERE source_type = 'alert' AND source_id = $1", [alert.id]);
    const notificationId = notificationRow.rows[0].id as string;
    expect(beforeIds).toContain(notificationId);
    expect(notificationRow.rows[0].acknowledged_at).toBeNull();

    const resolved = await resolveAlert(alert.id, { crewMemberId: crewId });
    expect(resolved.ok).toBe(true);

    const afterIds = (await listPendingNotifications()).map((n) => n.id);
    expect(afterIds).not.toContain(notificationId);

    const afterRow = await pool.query("SELECT * FROM notifications WHERE id = $1", [notificationId]);
    expect(afterRow.rows[0].acknowledged_at).not.toBeNull();
    expect(afterRow.rows[0].acknowledged_by).toBe(crewId);
  });

  it("a null related_record_id never dedups -- every call creates a fresh alert", async () => {
    const first = await raiseAlert({ type: "it_issue", summary: "freeform report 1" });
    const second = await raiseAlert({ type: "it_issue", summary: "freeform report 2" });
    createdAlertIds.push(first.alert.id, second.alert.id);
    expect(first.alert.id).not.toBe(second.alert.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
  });

  it("listAlerts filters by type and resolved status", async () => {
    const alerts = await listAlerts({ type: "maintenance_due", resolved: false });
    expect(alerts.every((a) => a.type === "maintenance_due" && a.resolved_at === null)).toBe(true);
  });
});

describe("notifications", () => {
  it("full lifecycle: pending -> attempted -> delivered -> escalation candidate -> escalated -> acknowledged", async () => {
    const { alert } = await raiseAlert({ type: "overdue", summary: "lifecycle test" });
    createdAlertIds.push(alert.id);
    const notificationRow = await pool.query("SELECT * FROM notifications WHERE source_id = $1", [alert.id]);
    const notificationId = notificationRow.rows[0].id as string;
    createdNotificationIds.push(notificationId);

    const pendingBefore = await listPendingNotifications();
    expect(pendingBefore.map((n) => n.id)).toContain(notificationId);

    await markNotificationAttempted(notificationId);
    const afterAttempt = await pool.query("SELECT send_attempts FROM notifications WHERE id = $1", [notificationId]);
    expect(afterAttempt.rows[0].send_attempts).toBe(1);

    await markNotificationDelivered(notificationId, "wamid.test123");
    const pendingAfter = await listPendingNotifications();
    expect(pendingAfter.map((n) => n.id)).not.toContain(notificationId);

    // Force it into escalation-candidate range by backdating delivered_at.
    await pool.query("UPDATE notifications SET delivered_at = now() - interval '25 minutes' WHERE id = $1", [notificationId]);
    const candidates = await listEscalationCandidates(20, 3);
    expect(candidates.map((n) => n.id)).toContain(notificationId);

    await escalateNotification(notificationId);
    const afterEscalate = await pool.query("SELECT escalated_count FROM notifications WHERE id = $1", [notificationId]);
    expect(afterEscalate.rows[0].escalated_count).toBe(1);

    const ack = await acknowledgeNotification(notificationId, { crewMemberId: crewId });
    expect(ack.ok).toBe(true);
    const doubleAck = await acknowledgeNotification(notificationId, { crewMemberId: crewId });
    expect(doubleAck.ok).toBe(false);
    if (!doubleAck.ok) expect(doubleAck.reason).toBe("already_acknowledged");

    // Acknowledged -- no longer a candidate even if otherwise due.
    const candidatesAfterAck = await listEscalationCandidates(20, 3);
    expect(candidatesAfterAck.map((n) => n.id)).not.toContain(notificationId);
  });

  it("a dashboard user can acknowledge a notification too -- acknowledged_by_user_id set, acknowledged_by left null", async () => {
    const { alert } = await raiseAlert({ type: "overdue", summary: "dashboard ack test" });
    createdAlertIds.push(alert.id);
    const notificationRow = await pool.query("SELECT id FROM notifications WHERE source_id = $1", [alert.id]);
    const notificationId = notificationRow.rows[0].id as string;
    createdNotificationIds.push(notificationId);

    const result = await acknowledgeNotification(notificationId, { userId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notification.acknowledged_by_user_id).toBe(userId);
    expect(result.notification.acknowledged_by).toBeNull();
  });
});

describe("notification settings", () => {
  it("reads the singleton row and applies a partial update", async () => {
    const before = await getNotificationSettings();
    expect(before.order_stall_hours).toBe(24);

    const updated = await updateNotificationSettings({ order_stall_hours: 12 });
    expect(updated.order_stall_hours).toBe(12);
    expect(updated.idle_hours).toBe(before.idle_hours); // untouched fields survive the partial update

    await updateNotificationSettings({ order_stall_hours: 24 }); // restore for other tests/checks
  });
});

describe("system self-monitoring", () => {
  it("reportBackupStatus(false) raises backup_failed against the singleton status row; success resets it", async () => {
    const failure = await reportBackupStatus(false);
    expect(failure).not.toBeNull();
    if (failure) createdAlertIds.push(failure.alert.id);

    const success = await reportBackupStatus(true);
    expect(success).toBeNull();

    const staleCheck = await checkBackupStale();
    expect(staleCheck).toBeNull(); // just reported success -- not stale
  });

  it("connectivity/disk health use fixed sentinel ids, so repeated failures dedup like any other alert", async () => {
    const first = await reportConnectivityHealth(true);
    const second = await reportConnectivityHealth(true);
    expect(first).not.toBeNull();
    expect(second?.created).toBe(false);
    if (first) createdAlertIds.push(first.alert.id);

    const healthy = await reportConnectivityHealth(false);
    expect(healthy).toBeNull();

    const disk = await reportDiskHealth(true);
    expect(disk).not.toBeNull();
    if (disk) createdAlertIds.push(disk.alert.id);
  });

  it("reportOfflineRecovery backfills a purely historical, pre-resolved record", async () => {
    const offlineSince = new Date(Date.now() - 10 * 60 * 1000);
    const recoveredAt = new Date();
    const { id } = await reportOfflineRecovery(offlineSince, recoveredAt);
    createdAlertIds.push(id);

    const row = await pool.query("SELECT * FROM alerts WHERE id = $1", [id]);
    expect(row.rows[0].type).toBe("system_offline");
    expect(row.rows[0].raised_at).toBeTruthy();
    expect(row.rows[0].resolved_at).toBeTruthy();
  });
});

describe("exceptions worker check functions", () => {
  it("checkOverdueCheckouts raises overdue against a real checkout past its expected return", async () => {
    const asset = await registerAsset({ name: "QA Overdue Check Asset" });
    createdAssetIds.push(asset.id);
    await pool.query("UPDATE assets SET status = 'available' WHERE id = $1", [asset.id]);
    const checkout = await createCheckout({ assetId: asset.id, checkedOutBy: crewId, expectedReturnAt: "2020-01-01T00:00:00Z" });
    expect(checkout.ok).toBe(true);
    if (!checkout.ok) return;
    createdCheckoutIds.push(checkout.checkout.id);

    await checkOverdueCheckouts();
    const alerts = await listAlerts({ type: "overdue" });
    const raised = alerts.find((a) => a.related_record_id === checkout.checkout.id);
    expect(raised).toBeTruthy();
    if (raised) createdAlertIds.push(raised.id);
  });

  it("checkStalledOrders raises order_stalled once an order has sat in 'requested' past the threshold", async () => {
    const order = await createOrder({ requesterId: crewId, siteId });
    createdOrderIds.push(order.id);
    await pool.query("UPDATE orders SET created_at = now() - interval '25 hours' WHERE id = $1", [order.id]);

    const settings = await getNotificationSettings();
    await checkStalledOrders(settings);
    const alerts = await listAlerts({ type: "order_stalled" });
    const raised = alerts.find((a) => a.related_record_id === order.id);
    expect(raised).toBeTruthy();
    if (raised) createdAlertIds.push(raised.id);
  });

  it("checkMaintenanceDue raises against an asset past its service interval, calculated from created_at when never serviced", async () => {
    const asset = await registerAsset({ name: "QA Maintenance Due Asset", serviceIntervalDays: 10 });
    createdAssetIds.push(asset.id);
    await pool.query("UPDATE assets SET created_at = now() - interval '11 days' WHERE id = $1", [asset.id]);

    await checkMaintenanceDue();
    const alerts = await listAlerts({ type: "maintenance_due" });
    const raised = alerts.find((a) => a.related_record_id === asset.id);
    expect(raised).toBeTruthy();
    if (raised) createdAlertIds.push(raised.id);
  });

  it("checkLoadoutGap raises one alert per job listing every missing asset, only for asset-backed loadout items", async () => {
    const jobTypes = await listJobTypes();
    const jobType = jobTypes[0];
    const job = await createJob({ siteId, jobTypeId: jobType.id, date: new Date().toISOString().slice(0, 10) });
    createdJobIds.push(job.id);

    const asset = await registerAsset({ name: "QA Loadout Gap Asset" });
    createdAssetIds.push(asset.id);
    const loadout = await createLoadout({ name: "QA Loadout Gap Kit", jobTypeId: jobType.id });
    createdLoadoutIds.push(loadout.id);
    await addLoadoutItem({ loadoutId: loadout.id, assetId: asset.id, quantity: 1 });

    const shift = await assignShift({ crewMemberId: crewId, siteId, date: new Date().toISOString().slice(0, 10), startTime: "00:01", jobId: job.id });
    createdShiftIds.push(shift.id);
    await confirmShift(shift.id, "confirmed");

    await checkLoadoutGap();
    const alerts = await listAlerts({ type: "loadout_gap" });
    const raised = alerts.find((a) => a.related_record_id === job.id);
    expect(raised).toBeTruthy();
    if (raised) createdAlertIds.push(raised.id);
  });

  it("checkWeather dedups within the same day, and self-heals daily -- resolving yesterday's open alert before raising a fresh one", async () => {
    const stubOverThreshold = async () => ({ precipitationProbabilityMax: 90, windspeed10mMax: 10 });
    const settings = await getNotificationSettings();

    await checkWeather(settings, stubOverThreshold);
    const firstPass = await pool.query("SELECT * FROM alerts WHERE type = 'weather' AND related_record_id = $1", [siteId]);
    expect(firstPass.rowCount).toBe(1);
    createdAlertIds.push(firstPass.rows[0].id);

    await checkWeather(settings, stubOverThreshold);
    const secondPass = await pool.query("SELECT * FROM alerts WHERE type = 'weather' AND related_record_id = $1", [siteId]);
    expect(secondPass.rowCount).toBe(1); // still just the one -- deduped, not a second alert

    // Simulate the open alert being from yesterday.
    await pool.query("UPDATE alerts SET raised_at = now() - interval '1 day' WHERE id = $1", [firstPass.rows[0].id]);
    await checkWeather(settings, stubOverThreshold);
    const thirdPass = await pool.query("SELECT * FROM alerts WHERE type = 'weather' AND related_record_id = $1 ORDER BY raised_at", [siteId]);
    expect(thirdPass.rowCount).toBe(2); // yesterday's is now resolved, a fresh one exists for today
    expect(thirdPass.rows[0].resolved_at).toBeTruthy();
    expect(thirdPass.rows[1].resolved_at).toBeNull();
    createdAlertIds.push(thirdPass.rows[1].id);
  });
});

describe("documents", () => {
  it("registers metadata-only and real uploaded documents, round-tripping the file content", async () => {
    const metadataOnly = await registerDocument({ type: "permit", filename: "permit.pdf", siteId });
    createdDocumentIds.push(metadataOnly.id);
    expect(metadataOnly.storage_path).toBeNull();

    const content = Buffer.from("fake png bytes for a test upload").toString("base64");
    const uploaded = await uploadDocument({ type: "photo", filename: "site.png", mimeType: "image/png", contentBase64: content, siteId });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    createdDocumentIds.push(uploaded.document.id);
    expect(uploaded.document.storage_path).toBeTruthy();
    expect(uploaded.document.storage_path).not.toBe("site.png"); // random filename, not user-derived

    const file = await readDocumentFile(uploaded.document.id);
    expect(file?.buffer.toString()).toBe("fake png bytes for a test upload");
  });

  it("rejects a disallowed MIME type and invalid base64", async () => {
    const badMime = await uploadDocument({ type: "photo", filename: "x.exe", mimeType: "application/x-msdownload", contentBase64: "AAAA" });
    expect(badMime.ok).toBe(false);
    if (!badMime.ok) expect(badMime.reason).toBe("mime_type_not_allowed");

    const badBase64 = await uploadDocument({ type: "photo", filename: "x.png", mimeType: "image/png", contentBase64: "" });
    expect(badBase64.ok).toBe(false);
    if (!badBase64.ok) expect(badBase64.reason).toBe("invalid_base64");
  });

  it("classifyDocument corrects a document's type after the fact", async () => {
    const doc = await registerDocument({ type: "photo", filename: "unclassified.jpg", siteId });
    createdDocumentIds.push(doc.id);
    const reclassified = await classifyDocument(doc.id, "receipt");
    expect(reclassified?.type).toBe("receipt");
  });

  it("listExpiringDocuments includes already-past-expiry rows, not just upcoming ones", async () => {
    const expired = await registerDocument({ type: "insurance_cert", filename: "expired.pdf", siteId, expiryDate: "2020-01-01" });
    createdDocumentIds.push(expired.id);
    const expiring = await listExpiringDocuments(30);
    expect(expiring.map((d) => d.id)).toContain(expired.id);
  });
});
