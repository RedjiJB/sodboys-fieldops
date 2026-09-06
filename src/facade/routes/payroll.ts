// Task #156 slice F. Maps payroll.ts (crew_pay_profiles + payouts,
// reconciled fresh via computeReconciliation -- no persisted payroll
// state at all) onto the vendored frontend's much richer batch/entry/
// deduction model with a real draft->submitted->approved->posted
// lifecycle -- exact field names confirmed by reading the frontend's own
// src/features/payroll/api.ts, not guessed.
//
// This domain has no "batch" concept, so there is exactly one, always:
// a synthetic batch (fixed id "current") recomputed fresh on every
// request from live timeclock/pay-profile/payout data for the current
// calendar month, never persisted. Its entries are exactly
// computeReconciliation's per-crew-member output, one row per crew
// member who has a pay profile configured (not every crew member,
// regardless of whether they're even set up for payroll).
//
// Deliberately NOT built here (see docs/ARCHITECTURE.md Task #156 scope
// table): the batch lifecycle (submit/finalize/post are accepted --
// matching the plan's no-op-pass-through decision established in
// procurement -- but never advance status past 'draft', since nothing in
// this domain tracks or gates that transition) and deductions (always []
// -- add/remove endpoints are omitted, not faked).
//
// Batch export (CSV/JSON), added after the fact: unlike the lifecycle/
// deductions gaps above, this needed no new domain concept -- it's just
// a formatting endpoint over the same buildCurrentBatch() entries the
// live view already computes and shows. The frontend's own
// downloadBatchExport() (src/features/payroll/api.ts) fetches this as a
// blob with a Bearer header rather than a bare <a href>, so a normal
// sendJson-shaped 404 previously surfaced to the user as "Export failed
// (404)" with no batch data lost -- this was a real missing route, not a
// documented scope cut.
import type { Router } from "../router.js";
import { readJsonBody, sendError, sendJson } from "../context.js";
import { requireStaffRole } from "../auth.js";
import { computeReconciliation, listCrewPayProfiles } from "../../domain/payroll.js";
import { getCrewMember } from "../../domain/crewMembers.js";

const SYNTHETIC_BATCH_ID = "current";

function currentPeriod(): { from: string; to: string; label: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    label: from.toLocaleString("en-US", { month: "long", year: "numeric" }),
  };
}

async function buildCurrentBatch(projectId: string) {
  const { from, to, label } = currentPeriod();
  const profiles = await listCrewPayProfiles();

  const entries = await Promise.all(profiles.map(async (profile) => {
    const crew = await getCrewMember(profile.crew_member_id);
    const recon = await computeReconciliation(profile.crew_member_id, from, to);
    return {
      id: profile.crew_member_id,
      batch_id: SYNTHETIC_BATCH_ID,
      resource_id: profile.crew_member_id,
      worker: crew?.name ?? "Unknown",
      work_date: null,
      hours: String(recon.hoursWorked.toFixed(2)),
      amount: String((recon.amountOwed ?? 0).toFixed(2)),
      net_amount: String((recon.amountOwed ?? 0).toFixed(2)), // no deductions modeled -- net always equals gross
      rate: recon.hourlyRate != null ? String(recon.hourlyRate) : "0",
      currency: "USD",
      source: "timeclock",
      metadata: {},
      deductions: [] as unknown[],
      created_at: from,
      updated_at: to,
    };
  }));

  const totalHours = entries.reduce((sum, e) => sum + Number(e.hours), 0);
  const totalAmount = entries.reduce((sum, e) => sum + Number(e.amount), 0);

  return {
    id: SYNTHETIC_BATCH_ID,
    project_id: projectId,
    period_label: label,
    period_start: from,
    period_end: to,
    status: "draft" as const,
    currency: "USD",
    total_hours: String(totalHours.toFixed(2)),
    total_amount: String(totalAmount.toFixed(2)),
    total_deductions: "0",
    total_net: String(totalAmount.toFixed(2)),
    entry_count: entries.length,
    notes: "",
    created_by: null,
    submitted_at: null,
    submitted_by: null,
    approved_at: null,
    approved_by: null,
    posted_at: null,
    posted_by: null,
    gl_transaction_ref: null,
    metadata: {},
    created_at: from,
    updated_at: to,
    entries,
  };
}

export function registerPayrollRoutes(router: Router): void {
  router.get("/api/v1/payroll/projects/:projectId/batches", async (req, res, { projectId }) => {
    try {
      await requireStaffRole(req);
      const batch = await buildCurrentBatch(projectId);
      const { entries: _entries, ...withoutEntries } = batch;
      sendJson(res, 200, [withoutEntries]);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/api/v1/payroll/projects/:projectId/batches", async (req, res, { projectId }) => {
    try {
      await requireStaffRole(req);
      await readJsonBody(req); // accepted, ignored -- there is no batch-generation parameterization to honor
      sendJson(res, 200, await buildCurrentBatch(projectId));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/api/v1/payroll/batches/:batchId", async (req, res) => {
    try {
      await requireStaffRole(req);
      // No real project scoping on this route in the frontend's own
      // contract (batchId alone) -- reuse whatever the caller's
      // dashboard session most recently implied is "the" project isn't
      // available here, so this echoes an empty project_id. Harmless:
      // nothing in this domain is actually keyed by it.
      sendJson(res, 200, await buildCurrentBatch(""));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/api/v1/payroll/projects/:projectId/labour-cost", async (req, res, { projectId }) => {
    try {
      await requireStaffRole(req);
      const batch = await buildCurrentBatch(projectId);
      sendJson(res, 200, { project_id: projectId, currency: "USD", labour_cost: batch.total_amount, total_hours: batch.total_hours });
    } catch (err) {
      sendError(res, err);
    }
  });

  // No gate exists in this domain between draft/submitted/approved/posted
  // -- accepted for the frontend's workflow buttons, but status never
  // advances past 'draft'. See the file header comment.
  for (const action of ["submit", "finalize", "post"]) {
    router.patch(`/api/v1/payroll/batches/:batchId/${action}`, async (req, res) => {
      try {
        await requireStaffRole(req);
        sendJson(res, 200, await buildCurrentBatch(""));
      } catch (err) {
        sendError(res, err);
      }
    });
  }

  // Batch hours and live source hours are the same query in this domain
  // (there is no separate "captured at generation time" snapshot to
  // drift from) -- so every row is honestly always balanced, not faked.
  router.get("/api/v1/payroll/batches/:batchId/reconcile", async (req, res) => {
    try {
      await requireStaffRole(req);
      const batch = await buildCurrentBatch("");
      sendJson(res, 200, {
        batch_id: SYNTHETIC_BATCH_ID,
        project_id: "",
        batch_total_hours: batch.total_hours,
        source_total_hours: batch.total_hours,
        delta_total_hours: "0.00",
        balanced: true,
        rows: batch.entries.map((e) => ({
          worker_key: e.worker,
          work_date: null,
          resource_id: e.resource_id,
          batch_hours: e.hours,
          source_hours: e.hours,
          delta_hours: "0.00",
          matched: true,
        })),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/api/v1/payroll/batches/:batchId/export.json", async (req, res) => {
    try {
      await requireStaffRole(req);
      const batch = await buildCurrentBatch("");
      const payload = JSON.stringify(batch, null, 2);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="payroll-batch-${SYNTHETIC_BATCH_ID}.json"`,
      });
      res.end(payload);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/api/v1/payroll/batches/:batchId/export.csv", async (req, res) => {
    try {
      await requireStaffRole(req);
      const batch = await buildCurrentBatch("");
      const header = ["worker", "hours", "rate", "amount", "net_amount", "currency"];
      const csvEscape = (value: string) =>
        /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      const rows = batch.entries.map((e) =>
        [e.worker, e.hours, Number(e.rate).toFixed(2), e.amount, e.net_amount, e.currency]
          .map((v) => csvEscape(String(v)))
          .join(","),
      );
      const csv = [header.join(","), ...rows].join("\r\n") + "\r\n";
      res.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="payroll-batch-${SYNTHETIC_BATCH_ID}.csv"`,
      });
      res.end(csv);
    } catch (err) {
      sendError(res, err);
    }
  });
}
