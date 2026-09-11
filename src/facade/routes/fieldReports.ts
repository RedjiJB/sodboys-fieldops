// Restoring Field Reports, Slice S: list/get/create only -- no
// templates, no approval lifecycle (no gate exists to advance past a
// single status, same honest call fieldTime.ts and payroll.ts already
// made for their own modules).
import type { Router } from "../router.js";
import { getQueryParam, readJsonBody, sendError, sendJson } from "../context.js";
import { requireStaffRole } from "../auth.js";
import { createFieldReport, listFieldReports, getFieldReport, getFieldReportContext, type FieldReport } from "../../domain/fieldReports.js";
import { getSite } from "../../domain/sites.js";
import { getUser } from "../../domain/users.js";
import { getCrewMember } from "../../domain/crewMembers.js";

type CreateBody = { site_id?: string; report_date?: string; notes?: string };

// Same Date-vs-string lesson as fieldReports.ts's own toDateOnlyString --
// node-postgres hands back report_date as a Date object at runtime, and
// leaving it unnormalized here would serialize as a full timestamp
// ("2026-01-01T00:00:00.000Z") instead of the plain date the frontend
// asked for.
function toFrontendShape(r: FieldReport) {
  const rawDate = r.report_date as unknown;
  const reportDate = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : r.report_date;
  return { ...r, report_date: reportDate };
}

export function registerFieldReportRoutes(router: Router): void {
  router.get("/api/v1/field-reports", async (req, res) => {
    try {
      await requireStaffRole(req);
      const siteId = getQueryParam(req, "site_id") ?? undefined;
      const reports = await listFieldReports(siteId);
      const items = await Promise.all(
        reports.map(async (r) => ({ ...toFrontendShape(r), site_name: (await getSite(r.site_id))?.name ?? "Unknown site" })),
      );
      sendJson(res, 200, { items });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/api/v1/field-reports", async (req, res) => {
    try {
      const user = await requireStaffRole(req);
      const body = await readJsonBody<CreateBody>(req);
      if (!body.site_id || !body.report_date || !body.notes?.trim()) {
        sendJson(res, 422, { detail: "site_id, report_date, and notes are required" });
        return;
      }
      const report = await createFieldReport({ siteId: body.site_id, reportDate: body.report_date, notes: body.notes.trim(), createdBy: user.userId });
      sendJson(res, 200, toFrontendShape(report));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/api/v1/field-reports/:id", async (req, res, { id }) => {
    try {
      await requireStaffRole(req);
      const report = await getFieldReport(id);
      if (!report) {
        sendJson(res, 404, { detail: "Not found" });
        return;
      }
      // Two independent author fields, at most one ever set (see
      // fieldReports.ts's own comment) -- a dashboard-authored report
      // resolves via users, a WhatsApp-authored one via crew_members.
      const [context, site, dashboardAuthor, crewAuthor] = await Promise.all([
        getFieldReportContext(report),
        getSite(report.site_id),
        report.created_by ? getUser(report.created_by) : Promise.resolve(null),
        report.created_by_crew_member_id ? getCrewMember(report.created_by_crew_member_id) : Promise.resolve(null),
      ]);
      const authorName = dashboardAuthor?.name ?? crewAuthor?.name ?? null;
      sendJson(res, 200, { ...toFrontendShape(report), ...context, site_name: site?.name ?? "Unknown site", author_name: authorName });
    } catch (err) {
      sendError(res, err);
    }
  });
}
