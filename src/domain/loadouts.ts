// Re-expressed from v1's loadouts/loadout_items domain logic --
// requirements baseline, not copied code. A loadout is a named, reusable
// kit template tied to a job type -- not a specific job or crew member.
import { pool } from "../db/pool.js";

export type Loadout = {
  id: string;
  name: string;
  job_type_id: string | null;
  created_at: string;
};

export type LoadoutItem = {
  id: string;
  loadout_id: string;
  asset_id: string | null;
  consumable_id: string | null;
  freeform_label: string | null;
  quantity: string; // NUMERIC
  scales_with_crew: boolean;
};

export async function createLoadout(args: { name: string; jobTypeId?: string }): Promise<Loadout> {
  const result = await pool.query(
    `INSERT INTO loadouts (name, job_type_id) VALUES ($1, $2) RETURNING *`,
    [args.name, args.jobTypeId ?? null],
  );
  return result.rows[0] as Loadout;
}

// Exactly one of assetId/consumableId/freeformLabel -- enforced by a DB
// CHECK (loadout_items_exactly_one_target), not re-validated here; a
// violation surfaces as a real constraint-violation error, same as any
// other malformed-input case in this codebase. freeformLabel lets a
// loadout list something ("boots") before it's ever registered as a real
// asset/consumable row -- matches how a crew member actually thinks about
// a personal kit (a list of stuff), not how the system otherwise requires
// it (a list of database rows).
export async function addLoadoutItem(args: {
  loadoutId: string;
  assetId?: string;
  consumableId?: string;
  freeformLabel?: string;
  quantity: number;
  scalesWithCrew?: boolean;
}): Promise<LoadoutItem> {
  const result = await pool.query(
    `INSERT INTO loadout_items (loadout_id, asset_id, consumable_id, freeform_label, quantity, scales_with_crew)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [args.loadoutId, args.assetId ?? null, args.consumableId ?? null, args.freeformLabel ?? null, args.quantity, args.scalesWithCrew ?? false],
  );
  return result.rows[0] as LoadoutItem;
}

export async function listLoadouts(filter?: { jobTypeId?: string }): Promise<Loadout[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.jobTypeId) {
    params.push(filter.jobTypeId);
    conditions.push(`job_type_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(`SELECT * FROM loadouts ${where} ORDER BY name`, params);
  return result.rows as Loadout[];
}

export type ResolvedLoadoutItem = LoadoutItem & { resolved_quantity: number };

// scales_with_crew items multiply by crew size at read time -- the base
// quantity stored on the row is always the per-crew-member or flat
// number, never the resolved total. Computed on every call, never cached.
export async function resolveLoadout(loadoutId: string, crewSize: number): Promise<ResolvedLoadoutItem[]> {
  const result = await pool.query("SELECT * FROM loadout_items WHERE loadout_id = $1", [loadoutId]);
  return (result.rows as LoadoutItem[]).map((item) => ({
    ...item,
    resolved_quantity: item.scales_with_crew ? Number(item.quantity) * crewSize : Number(item.quantity),
  }));
}
