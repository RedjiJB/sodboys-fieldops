import { McpServer } from "@modelcontextprotocol/server";
import { registerIdentityTools } from "./tools/identity.js";
import { registerSiteTools } from "./tools/sites.js";
import { registerCrewMemberTools } from "./tools/crewMembers.js";
import { registerJobTypeTools } from "./tools/jobTypes.js";
import { registerShiftTools } from "./tools/shifts.js";
import { registerTimeclockTools } from "./tools/timeclock.js";
import { registerConfirmationTools } from "./tools/confirmations.js";
import { registerVendorTools } from "./tools/vendors.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerConsumableTools } from "./tools/consumables.js";
import { registerLoadoutTools } from "./tools/loadouts.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerCheckoutTools } from "./tools/checkouts.js";
import { registerTransferTools } from "./tools/transfers.js";
import { registerPurchaseOrderTools } from "./tools/purchaseOrders.js";
import { registerVehicleTools } from "./tools/vehicles.js";
import { registerTelemetryTools } from "./tools/telemetry.js";
import { registerTripTools } from "./tools/trips.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerSystemHealthTools } from "./tools/systemHealth.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerUserTools } from "./tools/users.js";
import { registerMoneyInstrumentTools } from "./tools/moneyInstruments.js";
import { registerSpendingTools } from "./tools/spending.js";
import { registerPayrollTools } from "./tools/payroll.js";
import { registerKpiTools } from "./tools/kpis.js";
import { registerFieldReportTools } from "./tools/fieldReports.js";
import { registerAgentInteractionTools } from "./tools/agentInteractions.js";

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "dcentral-fieldops", version: "0.1.0" });
  registerIdentityTools(server);
  registerSiteTools(server);
  registerCrewMemberTools(server);
  registerJobTypeTools(server);
  registerShiftTools(server);
  registerTimeclockTools(server); // also registers the timeclock_event confirmation executor
  registerConfirmationTools(server);
  registerVendorTools(server);
  registerAssetTools(server); // also registers the asset_verification confirmation executor
  registerConsumableTools(server); // also registers the consumable_adjustment confirmation executor
  registerLoadoutTools(server);
  registerOrderTools(server);
  registerCheckoutTools(server); // also registers the checkout_return confirmation executor
  registerTransferTools(server);
  registerPurchaseOrderTools(server); // also registers the purchase_order_fulfillment confirmation executor
  registerVehicleTools(server);
  registerTelemetryTools(server);
  registerTripTools(server);
  registerAlertTools(server);
  registerNotificationTools(server);
  registerSystemHealthTools(server);
  registerDocumentTools(server);
  registerJobTools(server);
  registerUserTools(server);
  registerMoneyInstrumentTools(server);
  registerSpendingTools(server); // also registers the mileage_claim and spend_record confirmation executors
  registerPayrollTools(server);
  registerKpiTools(server);
  registerFieldReportTools(server);
  registerAgentInteractionTools(server);
  return server;
}

// A single shared instance -- every tool here is stateless (capability
// checks are argument-based per call, not connection-scoped), so both
// transports serving the same instance is correct, not a shortcut. See
// src/mcp/middleware.ts.
export const mcpServer = buildMcpServer();
