// One-time provisioning for the notification-delivery poller's agent
// identity -- same mechanism and idempotent-rerun shape as
// bootstrapOpsInfraAgent.ts. Closes a real, previously-documented gap:
// list_pending_notifications/mark_notification_delivered/etc. have existed
// as tier-4 "system-integration" MCP tools since Phase 2 slice 5, described
// in their own tool descriptions as "the delivery poller's own query" --
// but no agent identity was ever minted to actually call them, confirmed
// before writing this (grep across the codebase found zero callers besides
// their own tool registration). This agent identity is what a real poller
// (an OpenClaw cron job, see docs/ARCHITECTURE.md's notification-routing
// backlog entry) authenticates as.
//
// One shared identity for the poller role, not one per human recipient --
// the narrowness this mints is by CAPABILITY (four specific tools, nothing
// else), matching bootstrapOpsInfraAgent.ts's own principle; which actual
// person a given poller cron job pages is entirely a property of that
// job's own configuration (its prompt + delivery destination), not a
// property of which credential it holds.
import "dotenv/config";
import { pool } from "../db/pool.js";
import { didWebForAgent } from "./did.js";
import { generateAndStoreKeyPair } from "./keys.js";
import { getOrCreateSelfNode } from "./node.js";
import { issueCapabilityGrant } from "./capabilities.js";

const AGENT_ROLE = "notification-poller";
const CAPABILITIES = [
  "mcp:tool:list_pending_notifications",
  "mcp:tool:resolve_notification_recipients",
  "mcp:tool:mark_notification_attempted",
  "mcp:tool:mark_notification_delivered",
] as const;

async function main() {
  const domain = process.env.NODE_DID_DOMAIN;
  if (!domain) throw new Error("NODE_DID_DOMAIN is required to mint the notification-poller agent's identity");
  const did = didWebForAgent(domain, AGENT_ROLE);
  const selfNode = await getOrCreateSelfNode();

  const existingAgent = await pool.query("SELECT id FROM agent_identities WHERE did = $1", [did]);
  if (!existingAgent.rows[0]) {
    await generateAndStoreKeyPair(did);
    await pool.query(
      `INSERT INTO agent_identities (node_id, did, role, display_name) VALUES ($1, $2, $3, $4)`,
      [selfNode.id, did, AGENT_ROLE, "Notification Delivery Poller"],
    );
    console.log(`Agent identity created: ${did}`);
  } else {
    console.log(`Agent already provisioned: ${did}`);
  }

  for (const capability of CAPABILITIES) {
    const existingGrant = await pool.query(
      `SELECT id FROM capability_grants WHERE subject_did = $1 AND capability = $2 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
      [did, capability],
    );
    if (existingGrant.rows[0]) {
      console.log(`  ${capability}: live grant already exists, skipping`);
      continue;
    }
    const { jwt } = await issueCapabilityGrant({
      issuerDid: selfNode.did,
      issuerNodeId: selfNode.id,
      subjectDid: did,
      capability,
      tier: 4,
    });
    console.log(`  ${capability}:\n${jwt}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
