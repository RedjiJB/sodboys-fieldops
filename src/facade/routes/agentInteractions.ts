// Dashboard access to agent_interactions -- a real IT-management chat-
// review requirement, not just the weekly fine-tuning review's own input
// (see 0045_agent_interactions_transcripts.sql for why this table carries
// verbatim crew/bot message text, not just a paraphrase). Admin-gated:
// this is the closest thing this dashboard has to reading crew members'
// actual messages, the same sensitivity bar as Settings/webhook secrets.
import type { Router } from "../router.js";
import { getQueryInt, getQueryParam, sendError, sendJson } from "../context.js";
import { requireAdminRole } from "../auth.js";
import { listAgentInteractions } from "../../domain/agentInteractions.js";
import { getCrewMember } from "../../domain/crewMembers.js";

export function registerAgentInteractionRoutes(router: Router): void {
  router.get("/api/v1/agent-interactions", async (req, res) => {
    try {
      await requireAdminRole(req);
      const crewMemberId = getQueryParam(req, "crew_member_id") ?? undefined;
      const since = getQueryParam(req, "since") ?? undefined;
      const limit = getQueryInt(req, "limit", 100);

      const items = await listAgentInteractions({ crewMemberId, since });
      const page = items.slice(0, limit);

      // Resolve crew names once per unique id, not once per row -- the
      // same list is almost always dominated by a handful of crew
      // members, no reason to re-query the same person N times.
      const crewNameCache = new Map<string, string | null>();
      const withCrewNames = await Promise.all(
        page.map(async (item) => {
          if (!item.crew_member_id) return { ...item, crew_member_name: null };
          if (!crewNameCache.has(item.crew_member_id)) {
            const crew = await getCrewMember(item.crew_member_id);
            crewNameCache.set(item.crew_member_id, crew?.name ?? null);
          }
          return { ...item, crew_member_name: crewNameCache.get(item.crew_member_id) ?? null };
        }),
      );

      sendJson(res, 200, { items: withCrewNames, total: items.length });
    } catch (err) {
      sendError(res, err);
    }
  });
}
