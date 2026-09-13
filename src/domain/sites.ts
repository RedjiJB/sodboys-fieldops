import { pool } from "../db/pool.js";
import { fetchSessionsInRange } from "./timeclockSessions.js";
import { getCrewPayProfile } from "./payroll.js";
import { getNotificationSettings } from "./notificationSettings.js";
import { registerConfirmationExecutor } from "./confirmations.js";

export type SiteType = "job_site" | "depot" | "vendor" | "shop";

export type Site = {
  id: string;
  name: string;
  address: string | null;
  type: SiteType;
  access_instructions: string | null;
  access_hours: string | null;
  center_lat: number | null;
  center_lng: number | null;
  geofence_radius_m: number | null;
  geofence_polygon: unknown | null;
  active_start: string | null;
  active_end: string | null;
  budget: number | null;
  created_at: string;
};

export async function registerSite(args: {
  name: string;
  type: SiteType;
  address?: string;
  centerLat?: number;
  centerLng?: number;
  geofenceRadiusM?: number;
}): Promise<Site> {
  const result = await pool.query(
    `INSERT INTO sites (name, type, address, center_lat, center_lng, geofence_radius_m)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [args.name, args.type, args.address ?? null, args.centerLat ?? null, args.centerLng ?? null, args.geofenceRadiusM ?? null],
  );
  return result.rows[0] as Site;
}

export async function listSites(filter?: { type?: SiteType }): Promise<Site[]> {
  if (filter?.type) {
    const result = await pool.query("SELECT * FROM sites WHERE type = $1 ORDER BY name", [filter.type]);
    return result.rows as Site[];
  }
  const result = await pool.query("SELECT * FROM sites ORDER BY name");
  return result.rows as Site[];
}

export async function getSite(id: string): Promise<Site | null> {
  const result = await pool.query("SELECT * FROM sites WHERE id = $1", [id]);
  return (result.rows[0] as Site) ?? null;
}

export async function setSiteBudget(id: string, budget: number | null): Promise<Site | null> {
  const result = await pool.query("UPDATE sites SET budget = $2 WHERE id = $1 RETURNING *", [id, budget]);
  return (result.rows[0] as Site) ?? null;
}

export type SiteCostSummary = {
  budget: number | null;
  po_spend: number;
  labour_spend: number;
  total_spend: number;
  variance: number | null;
};

// Site Cost Summary -- the real replacement for the "5D Cost" chip (that
// label specifically means cost-loaded-schedule/BIM integration, which
// nothing in this domain backs; presenting this as "5D Cost" would be
// the same dishonest-label problem this project has fixed everywhere
// else it appeared). Two real spend sources, no invented ones:
//
// po_spend: purchase_orders.cost for POs whose order_id resolves to an
// orders row with a matching site_id. Freeform POs (no order_id) are
// excluded, not guessed into a site.
//
// labour_spend: reuses fetchSessionsInRange (payroll's own session
// computation, not re-derived) across this site's whole history, then
// keeps only sessions that actually visited this site (a session's
// siteIds -- a crew member's shift can span sites) and prices each by
// that crew member's own hourly rate. A crew member with no rate set
// contributes 0, not a guessed default -- matches computeReconciliation's
// own "no rate is a distinct state from $0" reasoning.
//
// variance is null (not 0) when budget is unset -- "no budget" is a
// distinct state from "on budget", never conflated.
export async function getSiteCostSummary(siteId: string): Promise<SiteCostSummary | null> {
  const site = await getSite(siteId);
  if (!site) return null;

  const poResult = await pool.query(
    `SELECT COALESCE(SUM(po.cost), 0) AS total
     FROM purchase_orders po
     JOIN orders o ON o.id = po.order_id
     WHERE o.site_id = $1`,
    [siteId],
  );
  const poSpend = Number(poResult.rows[0].total);

  const settings = await getNotificationSettings();
  const sessions = await fetchSessionsInRange({
    from: site.created_at,
    to: new Date().toISOString(),
    dailyOvertimeHours: settings.daily_overtime_hours,
    breakRequiredAfterHours: settings.break_required_after_hours,
  });
  const atThisSite = sessions.filter((s) => !s.incomplete && s.siteIds.includes(siteId));

  const rateCache = new Map<string, number | null>();
  let labourSpend = 0;
  for (const session of atThisSite) {
    let rate = rateCache.get(session.crewMemberId);
    if (rate === undefined) {
      const profile = await getCrewPayProfile(session.crewMemberId);
      rate = profile?.hourly_rate != null ? Number(profile.hourly_rate) : null;
      rateCache.set(session.crewMemberId, rate);
    }
    if (rate == null) continue;
    labourSpend += ((session.netSeconds ?? 0) / 3600) * rate;
  }

  const totalSpend = poSpend + labourSpend;
  const budget = site.budget != null ? Number(site.budget) : null;
  return {
    budget,
    po_spend: poSpend,
    labour_spend: labourSpend,
    total_spend: totalSpend,
    variance: budget != null ? budget - totalSpend : null,
  };
}

// Registered once at server startup (see src/mcp/tools/sites.ts) -- lets
// a crew member propose a new job site over WhatsApp ("track this
// against 184 Knudson") without needing dashboard access themselves,
// same confirm-before-execute shape as submit_consumable_adjustment.
// Real coordinates/geofencing still has to be added on the dashboard
// afterward if the site needs them; this just gets the row on the books
// so field reports/adjustments have something real to reference sooner
// than "go add it on the dashboard first."
export function registerSiteCreationExecutor(): void {
  registerConfirmationExecutor("site_creation", async (payload) => {
    const site = await registerSite({
      name: payload.name as string,
      type: (payload.type as SiteType | undefined) ?? "job_site",
      address: (payload.address as string | undefined) ?? undefined,
    });
    return { resultId: site.id };
  });
}

export type SiteWithActivityCounts = Site & { crew_today_count: number; open_alerts_count: number };

// Dashboard restoration, Slice M: for the site cards widget -- one query,
// LATERAL joins, same pattern as listVehicles()'s latest-telemetry join,
// avoiding N+1 for a dashboard data source. crew_today_count is distinct
// crew who clocked in at this site today (calendar day, not "currently
// still clocked in" -- that would need per-crew latest-event resolution,
// a heavier query for a summary tile that doesn't need that precision).
export async function listSitesWithActivityCounts(): Promise<SiteWithActivityCounts[]> {
  const result = await pool.query(
    `SELECT s.*,
       COALESCE(c.crew_today_count, 0) AS crew_today_count,
       COALESCE(a.open_alerts_count, 0) AS open_alerts_count
     FROM sites s
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT crew_member_id)::int AS crew_today_count
       FROM timeclock_entries te
       WHERE te.site_id = s.id AND te.event_type = 'in' AND te."timestamp" >= date_trunc('day', now())
     ) c ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS open_alerts_count
       FROM alerts al
       WHERE al.site_id = s.id AND al.resolved_at IS NULL
     ) a ON true
     ORDER BY s.name`,
  );
  return result.rows as SiteWithActivityCounts[];
}
