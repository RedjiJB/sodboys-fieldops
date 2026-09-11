// Crew members are DID-based identities now, by explicit instruction --
// not the phone-only model this file originally shipped with. The DID is
// custodially held (see src/db/migrations/0011_crew_members_did.sql's
// comment for why: a crew member interacts entirely through WhatsApp
// text, with no wallet to hold a private key themselves). phone stays the
// column WhatsApp identity resolution actually keys off of day to day --
// it's now also a signed PhoneBinding credential bound to the crew DID,
// not just a plain database value, so "which phone number does this DID
// belong to" is a verifiable claim, not an assertion.
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { didWebForDomain } from "../identity/did.js";
import { generateAndStoreKeyPair } from "../identity/keys.js";
import { getOrCreateSelfNode } from "../identity/node.js";
import { issuePhoneBindingJwt } from "../identity/vc.js";
import { issueCapabilityGrant, checkStandingCapability } from "../identity/capabilities.js";

export type CrewRole = "crew" | "foreman" | "yard" | "management" | "owner" | "IT";

export type CrewMember = {
  id: string;
  name: string;
  phone: string;
  role: CrewRole;
  did: string;
  active: boolean;
  preferred_language: string | null;
  created_at: string;
  deactivated_at: string | null;
};

// Roles that hold real authority (e.g. approving a confirm-before-execute
// action) get a real capability grant on their DID, not just a role
// string -- 'owner' also gets 'crew:role:management', matching v1's
// documented convention that owner is admin-equivalent-or-greater
// wherever a management check happens. Tier 1 is a flat "holds this role"
// gate, not a tiered scale -- the roles below are booleans, not degrees.
const ROLE_CAPABILITIES: Partial<Record<CrewRole, string[]>> = {
  management: ["crew:role:management"],
  owner: ["crew:role:management", "crew:role:owner"],
};

// Key generation, the PhoneBinding credential, any role capability grants,
// and the crew_members row all happen in one transaction -- otherwise a
// failure partway through (e.g. a duplicate phone number on the final
// insert) leaves a stranded DID with a real private key and signed
// credentials but no owning crew_members row, which then collides with any
// future attempt to reuse that state.
export async function registerCrewMember(args: { name: string; phone: string; role?: CrewRole }): Promise<CrewMember> {
  const role = args.role ?? "crew";
  const id = randomUUID();
  const domain = process.env.NODE_DID_DOMAIN;
  if (!domain) throw new Error("NODE_DID_DOMAIN is required to issue a crew member's DID");
  const did = `${didWebForDomain(domain)}:crew:${id}`;
  const selfNode = await getOrCreateSelfNode();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await generateAndStoreKeyPair(did, client);

    const jwt = await issuePhoneBindingJwt({ issuerDid: selfNode.did, subjectDid: did, phone: args.phone });
    await client.query(
      `INSERT INTO verifiable_credentials (jwt, issuer_did, subject_did, credential_type, issued_at)
       VALUES ($1, $2, $3, 'PhoneBinding', now())`,
      [jwt, selfNode.did, did],
    );

    for (const capability of ROLE_CAPABILITIES[role] ?? []) {
      await issueCapabilityGrant({ issuerDid: selfNode.did, issuerNodeId: selfNode.id, subjectDid: did, capability, tier: 1 }, client);
    }

    const result = await client.query(
      `INSERT INTO crew_members (id, name, phone, role, did) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, args.name, args.phone, role, did],
    );
    await client.query("COMMIT");
    return result.rows[0] as CrewMember;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type CrewMemberWithLatestLocation = CrewMember & {
  latest_location: { id: string; timestamp: string; lat: number; lng: number; source: string; address: string | null } | null;
};

// Mirrors vehicles.ts's listVehicles/getVehicle latest-location join
// exactly (LEFT JOIN LATERAL against that module's own telemetry table) --
// crew_members and crew_telemetry are two separate slices with no shared
// table either, same reasoning as vehicles/vehicle_telemetry.
export async function listCrewWithLatestLocation(filter?: { active?: boolean }): Promise<CrewMemberWithLatestLocation[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.active !== undefined) {
    params.push(filter.active);
    conditions.push(`c.active = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT c.*, t.latest_location
     FROM crew_members c
     LEFT JOIN LATERAL (
       SELECT to_jsonb(ct) - 'crew_member_id' AS latest_location
       FROM crew_telemetry ct
       WHERE ct.crew_member_id = c.id
       ORDER BY ct."timestamp" DESC
       LIMIT 1
     ) t ON true
     ${where}
     ORDER BY c.name`,
    params,
  );
  return result.rows as CrewMemberWithLatestLocation[];
}

export async function listCrewMembers(filter?: { role?: CrewRole; roles?: CrewRole[]; active?: boolean }): Promise<CrewMember[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.role) {
    params.push(filter.role);
    conditions.push(`role = $${params.length}`);
  }
  if (filter?.roles && filter.roles.length > 0) {
    params.push(filter.roles);
    conditions.push(`role = ANY($${params.length})`);
  }
  if (filter?.active !== undefined) {
    params.push(filter.active);
    conditions.push(`active = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(`SELECT * FROM crew_members ${where} ORDER BY name`, params);
  return result.rows as CrewMember[];
}

export async function getCrewMember(id: string): Promise<CrewMember | null> {
  const result = await pool.query("SELECT * FROM crew_members WHERE id = $1", [id]);
  return (result.rows[0] as CrewMember) ?? null;
}

export async function getCrewMemberByPhone(phone: string): Promise<CrewMember | null> {
  const result = await pool.query("SELECT * FROM crew_members WHERE phone = $1", [phone]);
  return (result.rows[0] as CrewMember) ?? null;
}

// Replaces the earlier plain "isManagementRole(reviewer.role)" string
// check -- a role column is exactly the kind of implicitly-trusted,
// non-cryptographically-verified state a zero-trust design pushes back
// against. This re-verifies a real capability grant's signature (via
// checkStandingCapability) rather than trusting whatever crew_members.role
// happens to say.
export async function hasManagementCapability(crewMemberDid: string): Promise<boolean> {
  const check = await checkStandingCapability(crewMemberDid, "crew:role:management", 1);
  return check.allowed;
}
