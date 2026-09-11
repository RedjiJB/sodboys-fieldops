// Structured agent-interaction logging -- built to close a real gap: no
// WhatsApp message content is retained anywhere (OpenClaw clears
// channel_ingress_events.payload_json after processing, confirmed live),
// so there was no material to review for prompt/tool fine-tuning. See
// 0043_agent_interactions.sql's header for why this is a structured
// paraphrase, not verbatim message retention.
import { pool } from "../db/pool.js";

export type AgentInteractionChannel = "whatsapp" | "dashboard_chat";
export type AgentInteractionOutcome = "resolved" | "partial" | "failed" | "unresolved_sender";

export type AgentInteraction = {
  id: string;
  channel: AgentInteractionChannel;
  crew_member_id: string | null;
  summary: string;
  tools_called: string[];
  outcome: AgentInteractionOutcome;
  created_at: string;
};

export async function logAgentInteraction(args: {
  channel: AgentInteractionChannel;
  crewMemberId?: string;
  summary: string;
  toolsCalled?: string[];
  outcome: AgentInteractionOutcome;
}): Promise<AgentInteraction> {
  const result = await pool.query(
    `INSERT INTO agent_interactions (channel, crew_member_id, summary, tools_called, outcome)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [args.channel, args.crewMemberId ?? null, args.summary, args.toolsCalled ?? [], args.outcome],
  );
  return result.rows[0] as AgentInteraction;
}

export async function listAgentInteractions(filter?: { since?: string; crewMemberId?: string; outcome?: AgentInteractionOutcome }): Promise<AgentInteraction[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.since) {
    params.push(filter.since);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filter?.crewMemberId) {
    params.push(filter.crewMemberId);
    conditions.push(`crew_member_id = $${params.length}`);
  }
  if (filter?.outcome) {
    params.push(filter.outcome);
    conditions.push(`outcome = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(`SELECT * FROM agent_interactions ${where} ORDER BY created_at DESC`, params);
  return result.rows as AgentInteraction[];
}

// The weekly fine-tuning review's real input: counts by outcome and the
// most-called tools over a window, computed here rather than making the
// review agent re-derive aggregate logic from raw rows every time.
export type AgentInteractionSummary = {
  total: number;
  byOutcome: Record<AgentInteractionOutcome, number>;
  topTools: { tool: string; count: number }[];
  unresolvedSenderCount: number;
};

export async function summarizeAgentInteractions(sinceIso: string): Promise<AgentInteractionSummary> {
  const rows = await listAgentInteractions({ since: sinceIso });
  const byOutcome: Record<AgentInteractionOutcome, number> = { resolved: 0, partial: 0, failed: 0, unresolved_sender: 0 };
  const toolCounts = new Map<string, number>();
  for (const row of rows) {
    byOutcome[row.outcome] += 1;
    for (const tool of row.tools_called) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }
  }
  const topTools = [...toolCounts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return { total: rows.length, byOutcome, topTools, unresolvedSenderCount: byOutcome.unresolved_sender };
}
