import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listAgentInteractions, logAgentInteraction, summarizeAgentInteractions } from "../../domain/agentInteractions.js";
import { requireCapability } from "../middleware.js";
import { credentialArg, deniedResult } from "./shared.js";

export function registerAgentInteractionTools(server: McpServer): void {
  server.registerTool(
    "log_interaction_summary",
    {
      title: "Log Interaction Summary",
      description:
        "Records a short, structured paraphrase of one WhatsApp exchange -- what the crew member asked, which tools resolved it, and the outcome. Never the crew member's verbatim message text (see 0043_agent_interactions.sql for why: this is a considered, structured-summary-only design, not a shortcut). Call this once per exchange, after responding. Minimum tier: 2.",
      inputSchema: z.object({
        ...credentialArg,
        channel: z.enum(["whatsapp", "dashboard_chat"]).default("whatsapp"),
        crewMemberId: z.string().uuid().optional().describe("Omit if the sender couldn't be resolved -- use outcome: 'unresolved_sender' instead."),
        summary: z.string().describe("One or two sentences: what was asked, what happened. No verbatim quoting of the crew member's message."),
        toolsCalled: z.array(z.string()).optional(),
        outcome: z.enum(["resolved", "partial", "failed", "unresolved_sender"]),
      }),
    },
    async ({ credentialJwt, ...args }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:log_interaction_summary", 2);
        const interaction = await logAgentInteraction(args);
        return { content: [{ type: "text", text: JSON.stringify(interaction) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "list_interaction_summaries",
    {
      title: "List Interaction Summaries",
      description: "Lists structured interaction summaries, optionally filtered by crew member or a since-date. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, crewMemberId: z.string().uuid().optional(), since: z.string().optional().describe("ISO timestamp") }),
    },
    async ({ credentialJwt, crewMemberId, since }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:list_interaction_summaries", 0);
        const items = await listAgentInteractions({ crewMemberId, since });
        return { content: [{ type: "text", text: JSON.stringify(items) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "get_interaction_summary_report",
    {
      title: "Get Interaction Summary Report",
      description:
        "Aggregates interaction summaries since a given date: total count, breakdown by outcome, most-called tools, and how many messages had no resolvable sender. This is the real input for a weekly fine-tuning review. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, since: z.string().describe("ISO timestamp, e.g. 7 days ago") }),
    },
    async ({ credentialJwt, since }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:get_interaction_summary_report", 0);
        const report = await summarizeAgentInteractions(since);
        return { content: [{ type: "text", text: JSON.stringify(report) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );
}
