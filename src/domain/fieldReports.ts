// Restoring Field Reports, Slice S: re-scoped to sites + crew (this
// domain's real place/people concepts) instead of the vendored page's
// project_id (27 references throughout, no project concept exists
// here). Workforce and equipment are derived live, never duplicated --
// see 0040_field_reports.sql's header for the full reasoning.
import { pool } from "../db/pool.js";
import { getSite } from "./sites.js";
import { getCrewMember } from "./crewMembers.js";
import { getVehicle } from "./vehicles.js";
import { getUser } from "./users.js";
import { haversineDistanceMeters } from "./geo.js";

export class InvalidFieldReportAuthorError extends Error {
  constructor(public reason: "unknown_user" | "unknown_crew_member") {
    super(reason === "unknown_user" ? "createdBy is not a real user id" : "createdByCrewMemberId is not a real crew member id");
    this.name = "InvalidFieldReportAuthorError";
  }
}

export type FieldReport = {
  id: string;
  site_id: string;
  report_date: string;
  notes: string;
  created_by: string | null;
  created_by_crew_member_id: string | null;
  created_at: string;
};

// Two independent, optional author fields, never one required actor type --
// the dashboard (a real dashboard user, requireStaffRole-gated) and the
// WhatsApp bot (a real crew member, resolved from the sender's phone) are
// genuinely different identity systems with no FK between them (same
// "users and crew_members are independent identities" rule this whole
// project follows). createdBy must be a real users.id if supplied;
// createdByCrewMemberId must be a real crew_members.id if supplied -- the
// caller supplies whichever one it actually has, never both, never neither
// silently coerced into the other. This is the real fix for the FK
// violation previously hit when the WhatsApp bot (which only ever has a
// crew-member identity) passed that id into what was then a users-only
// column.
export async function createFieldReport(args: {
  siteId: string;
  reportDate: string;
  notes: string;
  createdBy?: string;
  createdByCrewMemberId?: string;
}): Promise<FieldReport> {
  // Validate before the insert -- turns what used to be a raw FK-violation
  // Postgres error (the exact bug this fixes) into a clean, actionable
  // rejection a caller can actually handle, matching the "raw DB errors
  // reaching user-facing alerts" pattern flagged as a broader gap in
  // docs/ARCHITECTURE.md's backlog.
  if (args.createdBy && !(await getUser(args.createdBy))) {
    throw new InvalidFieldReportAuthorError("unknown_user");
  }
  if (args.createdByCrewMemberId && !(await getCrewMember(args.createdByCrewMemberId))) {
    throw new InvalidFieldReportAuthorError("unknown_crew_member");
  }
  const result = await pool.query(
    `INSERT INTO field_reports (site_id, report_date, notes, created_by, created_by_crew_member_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [args.siteId, args.reportDate, args.notes, args.createdBy ?? null, args.createdByCrewMemberId ?? null],
  );
  return result.rows[0] as FieldReport;
}

export async function listFieldReports(siteId?: string): Promise<FieldReport[]> {
  if (siteId) {
    const result = await pool.query("SELECT * FROM field_reports WHERE site_id = $1 ORDER BY report_date DESC, created_at DESC", [siteId]);
    return result.rows as FieldReport[];
  }
  const result = await pool.query("SELECT * FROM field_reports ORDER BY report_date DESC, created_at DESC");
  return result.rows as FieldReport[];
}

export async function getFieldReport(id: string): Promise<FieldReport | null> {
  const result = await pool.query("SELECT * FROM field_reports WHERE id = $1", [id]);
  return (result.rows[0] as FieldReport) ?? null;
}

export type FieldReportWorkforceEntry = { crew_member_id: string; name: string };
export type FieldReportEquipmentEntry = { vehicle_id: string; plate: string };

// A site with no geofence configured (no center_lat/lng, or no
// geofence_radius_m) has no honest way to say which vehicles were
// "there" -- an empty list, not a guessed one. Sites that do have a
// radius use it; sites that have coordinates but no explicit radius get
// a generous default (GPS pings are rarely pinpoint-precise), never an
// invented geofence for a site with no coordinates at all.
const DEFAULT_GEOFENCE_RADIUS_M = 500;

// node-postgres hands back a DATE column as a JS Date object at runtime
// despite the FieldReport type declaring report_date as string -- the
// same "string annotation only holds true once JSON.stringify coerces
// it" lesson activity.ts's own toIso() already documents. Template-
// interpolating the raw value here previously produced a Date's
// .toString() output ("Mon Jan 01 2026 00:00:00 GMT-0400 (...)") instead
// of an ISO date, which Postgres then rejected as an invalid timestamp.
function toDateOnlyString(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

export async function getFieldReportContext(report: FieldReport): Promise<{ workforce: FieldReportWorkforceEntry[]; equipment: FieldReportEquipmentEntry[] }> {
  const reportDate = toDateOnlyString(report.report_date);
  const dayStart = `${reportDate}T00:00:00.000Z`;
  const dayEnd = `${reportDate}T23:59:59.999Z`;

  const workforceResult = await pool.query(
    `SELECT DISTINCT crew_member_id FROM timeclock_entries
     WHERE site_id = $1 AND event_type = 'in' AND "timestamp" BETWEEN $2 AND $3`,
    [report.site_id, dayStart, dayEnd],
  );
  const workforce: FieldReportWorkforceEntry[] = [];
  for (const row of workforceResult.rows as { crew_member_id: string }[]) {
    const crew = await getCrewMember(row.crew_member_id);
    if (crew) workforce.push({ crew_member_id: crew.id, name: crew.name });
  }

  const site = await getSite(report.site_id);
  let equipment: FieldReportEquipmentEntry[] = [];
  if (site && site.center_lat != null && site.center_lng != null) {
    const radius = site.geofence_radius_m ?? DEFAULT_GEOFENCE_RADIUS_M;
    const telemetryResult = await pool.query(
      `SELECT DISTINCT ON (vehicle_id) vehicle_id, lat, lng FROM vehicle_telemetry
       WHERE "timestamp" BETWEEN $1 AND $2
       ORDER BY vehicle_id, "timestamp" DESC`,
      [dayStart, dayEnd],
    );
    const nearby = (telemetryResult.rows as { vehicle_id: string; lat: number; lng: number }[]).filter(
      (row) => haversineDistanceMeters(row.lat, row.lng, site.center_lat as number, site.center_lng as number) <= radius,
    );
    for (const row of nearby) {
      const vehicle = await getVehicle(row.vehicle_id);
      if (vehicle) equipment.push({ vehicle_id: vehicle.id, plate: vehicle.plate });
    }
  }

  return { workforce, equipment };
}
