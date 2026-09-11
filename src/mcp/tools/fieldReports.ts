import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { createFieldReport, getFieldReport, getFieldReportContext, listFieldReports, InvalidFieldReportAuthorError } from "../../domain/fieldReports.js";
import { requireCapability } from "../middleware.js";
import { credentialArg, deniedResult } from "./shared.js";

export function registerFieldReportTools(server: McpServer): void {
  server.registerTool(
    "create_field_report",
    {
      title: "Create Field Report",
      description:
        "Records a narrative field report for a site/date -- notes only. Workforce and equipment present are derived live from real timeclock/telemetry data (see get_field_report), never duplicated into this record. createdByCrewMemberId should be the crew member's real id you already resolved for this sender -- never a dashboard user id (field reports created from the dashboard use a separate, users-scoped path). Minimum tier: 2.",
      inputSchema: z.object({
        ...credentialArg,
        siteId: z.string().uuid(),
        reportDate: z.string().describe("ISO date, e.g. 2026-08-24"),
        notes: z.string(),
        createdByCrewMemberId: z.string().uuid().optional().describe("The resolved crew member's id, if you resolved one."),
      }),
    },
    async ({ credentialJwt, ...args }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:create_field_report", 2);
        const report = await createFieldReport(args);
        return { content: [{ type: "text", text: JSON.stringify(report) }] };
      } catch (err) {
        if (err instanceof InvalidFieldReportAuthorError) {
          return { content: [{ type: "text", text: `Rejected: ${err.message}` }], isError: true };
        }
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "list_field_reports",
    {
      title: "List Field Reports",
      description: "Lists field reports, optionally filtered by site, newest first. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, siteId: z.string().uuid().optional() }),
    },
    async ({ credentialJwt, siteId }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:list_field_reports", 0);
        const reports = await listFieldReports(siteId);
        return { content: [{ type: "text", text: JSON.stringify(reports) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "get_field_report",
    {
      title: "Get Field Report",
      description:
        "Fetches a single field report by id, plus its derived workforce (crew clocked in at that site that day) and equipment (vehicles telemetry-confirmed at that site that day). Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, id: z.string().uuid() }),
    },
    async ({ credentialJwt, id }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:get_field_report", 0);
        const report = await getFieldReport(id);
        if (!report) return { content: [{ type: "text", text: "Not found" }], isError: true };
        const context = await getFieldReportContext(report);
        return { content: [{ type: "text", text: JSON.stringify({ ...report, ...context }) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );
}
