import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { addLoadoutItem, createLoadout, listLoadouts, resolveLoadout } from "../../domain/loadouts.js";
import { requireCapability } from "../middleware.js";
import { credentialArg, deniedResult } from "./shared.js";

export function registerLoadoutTools(server: McpServer): void {
  server.registerTool(
    "create_loadout",
    {
      title: "Create Loadout",
      description: "Creates a named, reusable kit template tied to a job type. Minimum tier: 3.",
      inputSchema: z.object({ ...credentialArg, name: z.string(), jobTypeId: z.string().uuid().optional() }),
    },
    async ({ credentialJwt, ...args }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:create_loadout", 3);
        const loadout = await createLoadout(args);
        return { content: [{ type: "text", text: JSON.stringify(loadout) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "add_loadout_item",
    {
      title: "Add Loadout Item",
      description:
        "Adds one line to a loadout -- exactly one of assetId/consumableId/freeformLabel must be set. freeformLabel is a placeholder for something not yet registered as a real asset/consumable (e.g. 'boots'), for when a loadout is being put together before every item has a database row. scalesWithCrew items multiply by crew size when resolved, not stored pre-multiplied. Minimum tier: 3.",
      inputSchema: z.object({
        ...credentialArg,
        loadoutId: z.string().uuid(),
        assetId: z.string().uuid().optional(),
        consumableId: z.string().uuid().optional(),
        freeformLabel: z.string().optional(),
        quantity: z.number().positive(),
        scalesWithCrew: z.boolean().optional(),
      }),
    },
    async ({ credentialJwt, ...args }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:add_loadout_item", 3);
        const item = await addLoadoutItem(args);
        return { content: [{ type: "text", text: JSON.stringify(item) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "list_loadouts",
    {
      title: "List Loadouts",
      description: "Lists loadout templates, optionally filtered by job type. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, jobTypeId: z.string().uuid().optional() }),
    },
    async ({ credentialJwt, jobTypeId }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:list_loadouts", 0);
        const loadouts = await listLoadouts({ jobTypeId });
        return { content: [{ type: "text", text: JSON.stringify(loadouts) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "resolve_loadout",
    {
      title: "Resolve Loadout",
      description: "Resolves a loadout's items against a given crew size, computing resolved_quantity for scales_with_crew items. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg, loadoutId: z.string().uuid(), crewSize: z.number().int().positive() }),
    },
    async ({ credentialJwt, loadoutId, crewSize }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:resolve_loadout", 0);
        const items = await resolveLoadout(loadoutId, crewSize);
        return { content: [{ type: "text", text: JSON.stringify(items) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );
}
