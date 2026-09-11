// The REST façade -- a separate process/entry point from the MCP HTTP
// transport (src/mcp/transports/http.ts), which stays untouched. Façade
// route handlers call src/domain/*.ts functions directly, never through
// the MCP tool layer -- this sidesteps "how does a browser session
// become a capability-bearing MCP caller" entirely, since the façade
// enforces real authorization itself (src/facade/auth.ts) and has no
// need to round-trip through MCP for its own process's domain calls.
import "dotenv/config";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { Router } from "./router.js";
import { sendJson } from "./context.js";
import { checkFacadeRateLimit, sendRateLimited } from "./rateLimit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerEquipmentRoutes } from "./routes/equipment.js";
import { registerSiteInventoryRoutes } from "./routes/siteInventory.js";
import { registerProcurementRoutes } from "./routes/procurement.js";
import { registerPayrollRoutes } from "./routes/payroll.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerFieldTimeRoutes } from "./routes/fieldTime.js";
import { registerLocationRoutes } from "./routes/locations.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerSiteRoutes } from "./routes/sites.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerWebhookTargetRoutes } from "./routes/webhookTargets.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerKpiRoutes } from "./routes/kpis.js";
import { registerFieldReportRoutes } from "./routes/fieldReports.js";
import { registerVendorRoutes } from "./routes/vendors.js";

export function buildFacadeServer(): Server {
  const router = new Router();
  registerAuthRoutes(router);
  registerNotificationRoutes(router);
  registerEquipmentRoutes(router);
  registerSiteInventoryRoutes(router);
  registerProcurementRoutes(router);
  registerPayrollRoutes(router);
  registerResourceRoutes(router);
  registerTeamRoutes(router);
  registerFieldTimeRoutes(router);
  registerLocationRoutes(router);
  registerChatRoutes(router);
  registerSiteRoutes(router);
  registerSystemRoutes(router);
  registerActivityRoutes(router);
  registerInboxRoutes(router);
  registerWebhookTargetRoutes(router);
  registerSettingsRoutes(router);
  registerKpiRoutes(router);
  registerFieldReportRoutes(router);
  registerVendorRoutes(router);

  return createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const rateLimit = checkFacadeRateLimit(req, pathname);
    if (!rateLimit.allowed) {
      sendRateLimited(res, rateLimit.retryAfterSeconds);
      return;
    }
    router.dispatch(req, res).then((handled) => {
      if (!handled) sendJson(res, 404, { detail: "Not found" });
    }).catch((err) => {
      console.error("[facade] unhandled dispatch error", err);
      if (!res.headersSent) sendJson(res, 500, { detail: "Internal server error" });
    });
  });
}

// Only actually listen when this module is run directly (npm run
// facade:http) -- importing buildFacadeServer for tests must not have
// the side effect of binding a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FACADE_HTTP_PORT ?? 8199);
  buildFacadeServer().listen(port, () => {
    console.log(`REST façade listening on :${port}`);
  });
}
