import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  getConsumable,
  getConsumablePriceHistory,
  listConsumables,
  registerConsumable,
  registerConsumableAdjustmentExecutor,
  registerConsumableCreationExecutor,
} from "../../domain/consumables.js";
import { submitForConfirmation } from "../../domain/confirmations.js";
import { requireCapability } from "../middleware.js";
import { credentialArg, deniedResult } from "./shared.js";

const stockingTypeSchema = z.enum(["stocked", "per_job_delivery"]);

export function registerConsumableTools(server: McpServer): void {
  registerConsumableAdjustmentExecutor();
  registerConsumableCreationExecutor();

  server.registerTool(
    "submit_consumable_creation",
    {
      title: "Submit Consumable Creation",
      description:
        "Proposes a new consumable material type for management review -- lets a crew member set up something like 'sod rolls -- yard stock' from chat instead of needing dashboard access. Does not create it directly: creates a pending_confirmations row. Minimum tier: 2.",
      inputSchema: z.object({
        ...credentialArg,
        name: z.string(),
        unit: z.string(),
        stockingType: stockingTypeSchema,
        reorderThreshold: z.number().optional(),
        submittedByCrewMemberId: z.string().uuid(),
      }),
    },
    async ({ credentialJwt, name, unit, stockingType, reorderThreshold, submittedByCrewMemberId }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:submit_consumable_creation", 2);
        const pending = await submitForConfirmation({
          actionType: "consumable_creation",
          capability: "mcp:tool:submit_consumable_creation",
          summary: `New consumable: ${name} (${unit}, ${stockingType})`,
          payload: { name, unit, stockingType, reorderThreshold: reorderThreshold ?? null },
          submittedByCrewMemberId,
        });
        return { content: [{ type: "text", text: JSON.stringify({ status: "awaiting_review", pendingConfirmationId: pending.id }) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "register_consumable",
    {
      title: "Register Consumable",
      description:
        "Adds a new consumable material type. 'stocked' types get a real quantity_on_hand (starts at 0); 'per_job_delivery' types never track quantity_on_hand at all. Minimum tier: 3.",
      inputSchema: z.object({
        ...credentialArg,
        name: z.string(),
        unit: z.string(),
        stockingType: stockingTypeSchema,
        reorderThreshold: z.number().optional(),
        preferredVendorId: z.string().uuid().optional(),
      }),
    },
    async ({ credentialJwt, ...args }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:register_consumable", 3);
        const consumable = await registerConsumable(args);
        return { content: [{ type: "text", text: JSON.stringify(consumable) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "submit_consumable_adjustment",
    {
      title: "Submit Consumable Adjustment",
      description:
        "Submits a stocked consumable's quantity adjustment (a signed delta) for management review -- a crew member's own usage report isn't trusted alone. Does not execute directly: creates a pending_confirmations row. Fails at approval time if the consumable isn't 'stocked'. Optional note/siteId capture which job the movement relates to -- the adjustment itself only ever changes the running quantity_on_hand, so this is the one place that provenance survives (in the pending_confirmations record), not on the consumable row. siteId isn't validated against a real site, since the job may not be registered as a site yet -- say it in note either way. Minimum tier: 2.",
      inputSchema: z.object({
        ...credentialArg,
        consumableId: z.string().uuid(),
        delta: z.number(),
        submittedByCrewMemberId: z.string().uuid(),
        note: z.string().optional(),
        siteId: z.string().uuid().optional(),
      }),
    },
    async ({ credentialJwt, consumableId, delta, submittedByCrewMemberId, note, siteId }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:submit_consumable_adjustment", 2);
        const pending = await submitForConfirmation({
          actionType: "consumable_adjustment",
          capability: "mcp:tool:submit_consumable_adjustment",
          summary: `Quantity adjustment of ${delta} for consumable ${consumableId}${note ? ` -- ${note}` : ""}`,
          payload: { consumableId, delta, note: note ?? null, siteId: siteId ?? null },
          submittedByCrewMemberId,
        });
        return { content: [{ type: "text", text: JSON.stringify({ status: "awaiting_review", pendingConfirmationId: pending.id }) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "list_consumables",
    {
      title: "List Consumables",
      description: "Lists consumables, optionally filtered by stocking type. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, stockingType: stockingTypeSchema.optional() }),
    },
    async ({ credentialJwt, stockingType }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:list_consumables", 0);
        const consumables = await listConsumables({ stockingType });
        return { content: [{ type: "text", text: JSON.stringify(consumables) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "get_consumable",
    {
      title: "Get Consumable",
      description: "Fetches a single consumable by id. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, id: z.string().uuid() }),
    },
    async ({ credentialJwt, id }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:get_consumable", 0);
        const consumable = await getConsumable(id);
        if (!consumable) return { content: [{ type: "text", text: "Not found" }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(consumable) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "get_consumable_price_history",
    {
      title: "Get Consumable Price History",
      description: "Real per-purchase prices actually paid for a consumable, newest first (from order_items.unit_cost). Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, consumableId: z.string().uuid() }),
    },
    async ({ credentialJwt, consumableId }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:get_consumable_price_history", 0);
        const history = await getConsumablePriceHistory(consumableId);
        return { content: [{ type: "text", text: JSON.stringify(history) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );
}
