// Re-expressed from v1's consumables domain logic -- requirements
// baseline, not copied code. 'stocked' consumables have a real
// quantity_on_hand; 'per_job_delivery' ones never do (ordered fresh per
// job, tracked by order_items.quantity instead). Unlike assets,
// consumables are never checked out -- only consumed or adjusted.
import { pool } from "../db/pool.js";
import { registerConfirmationExecutor } from "./confirmations.js";

export type StockingType = "stocked" | "per_job_delivery";

export type Consumable = {
  id: string;
  name: string;
  unit: string;
  stocking_type: StockingType;
  quantity_on_hand: string | null; // NUMERIC comes back as string from pg
  reorder_threshold: string | null;
  preferred_vendor_id: string | null;
  last_verified_at: string | null;
  created_at: string;
};

export async function registerConsumable(args: {
  name: string;
  unit: string;
  stockingType: StockingType;
  reorderThreshold?: number;
  preferredVendorId?: string;
}): Promise<Consumable> {
  const result = await pool.query(
    `INSERT INTO consumables (name, unit, stocking_type, quantity_on_hand, reorder_threshold, preferred_vendor_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      args.name,
      args.unit,
      args.stockingType,
      args.stockingType === "stocked" ? 0 : null,
      args.reorderThreshold ?? null,
      args.preferredVendorId ?? null,
    ],
  );
  return result.rows[0] as Consumable;
}

export async function listConsumables(filter?: { stockingType?: StockingType }): Promise<Consumable[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.stockingType) {
    params.push(filter.stockingType);
    conditions.push(`stocking_type = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(`SELECT * FROM consumables ${where} ORDER BY name`, params);
  return result.rows as Consumable[];
}

export async function getConsumable(id: string): Promise<Consumable | null> {
  const result = await pool.query("SELECT * FROM consumables WHERE id = $1", [id]);
  return (result.rows[0] as Consumable) ?? null;
}

// The real transaction price actually paid, per purchase -- lives on
// order_items.unit_cost, not a fixed catalog field, since unit cost
// varies per purchase. Newest first.
export async function getConsumablePriceHistory(consumableId: string): Promise<{ order_id: string; unit_cost: string; created_at: string }[]> {
  const result = await pool.query(
    `SELECT o.id AS order_id, oi.unit_cost, o.created_at
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.consumable_id = $1 AND oi.unit_cost IS NOT NULL
     ORDER BY o.created_at DESC`,
    [consumableId],
  );
  return result.rows;
}

export type AdjustQuantityResult =
  | { ok: true; consumable: Consumable }
  | { ok: false; reason: "not_found" | "not_stocked" };

// The actual effect, only ever run by the confirmation executor below --
// a crew member's own usage/quantity report isn't trusted alone (same
// reasoning as checkout damage claims and timeclock events).
async function applyQuantityDelta(consumableId: string, delta: number): Promise<AdjustQuantityResult> {
  const existing = await pool.query("SELECT * FROM consumables WHERE id = $1", [consumableId]);
  const row = existing.rows[0] as Consumable | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.stocking_type !== "stocked") return { ok: false, reason: "not_stocked" };

  const result = await pool.query(
    `UPDATE consumables SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + $2 WHERE id = $1 RETURNING *`,
    [consumableId, delta],
  );
  return { ok: true, consumable: result.rows[0] as Consumable };
}

// Registered once at server startup (see src/mcp/tools/consumables.ts).
export function registerConsumableAdjustmentExecutor(): void {
  registerConfirmationExecutor("consumable_adjustment", async (payload) => {
    const consumableId = payload.consumableId as string;
    const delta = payload.delta as number;
    const result = await applyQuantityDelta(consumableId, delta);
    if (!result.ok) throw new Error(`consumable_adjustment failed: ${result.reason}`);
    return { resultId: result.consumable.id };
  });
}

// Registered once at server startup (see src/mcp/tools/consumables.ts) --
// lets a crew member propose a new consumable ("sod rolls -- yard
// stock") from chat, same confirm-before-execute shape as site_creation.
export function registerConsumableCreationExecutor(): void {
  registerConfirmationExecutor("consumable_creation", async (payload) => {
    const consumable = await registerConsumable({
      name: payload.name as string,
      unit: payload.unit as string,
      stockingType: payload.stockingType as StockingType,
      reorderThreshold: (payload.reorderThreshold as number | undefined) ?? undefined,
    });
    return { resultId: consumable.id };
  });
}
