import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  acknowledgeNotification,
  escalateNotification,
  listEscalationCandidates,
  listPendingNotifications,
  markNotificationAttempted,
  markNotificationDelivered,
  resolveNotificationRecipients,
} from "../../domain/notifications.js";
import { getNotificationSettings, updateNotificationSettings } from "../../domain/notificationSettings.js";
import { requireCapability } from "../middleware.js";
import { credentialArg, deniedResult } from "./shared.js";

export function registerNotificationTools(server: McpServer): void {
  server.registerTool(
    "get_notification_settings",
    {
      title: "Get Notification Settings",
      description: "Reads the single notification_settings row. Minimum tier: 0 (read-only).",
      inputSchema: z.object({ ...credentialArg }),
    },
    async ({ credentialJwt }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:get_notification_settings", 0);
        const settings = await getNotificationSettings();
        return { content: [{ type: "text", text: JSON.stringify(settings) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "update_notification_settings",
    {
      title: "Update Notification Settings",
      description: "Updates any subset of the notification_settings singleton row. Real policy-level configuration change. Minimum tier: 4.",
      inputSchema: z.object({
        ...credentialArg,
        escalationThresholdMinutes: z.number().int().optional(),
        maxEscalations: z.number().int().optional(),
        vehicleDarkCritical: z.boolean().optional(),
        criticalNotificationRoles: z.array(z.string()).optional(),
        itEscalationRoles: z.array(z.string()).optional(),
        orderStallHours: z.number().int().optional(),
        idleHours: z.number().int().optional(),
        delayBufferMinutes: z.number().int().optional(),
        rainProbabilityThreshold: z.number().int().optional(),
        windSpeedThresholdKmh: z.number().int().optional(),
        dailyOvertimeHours: z.number().int().optional(),
        breakRequiredAfterHours: z.number().int().optional(),
        crewLocationStaleMinutes: z.number().int().optional(),
      }),
    },
    async ({ credentialJwt, ...args }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:update_notification_settings", 4);
        const settings = await updateNotificationSettings({
          escalation_threshold_minutes: args.escalationThresholdMinutes,
          max_escalations: args.maxEscalations,
          vehicle_dark_critical: args.vehicleDarkCritical,
          critical_notification_roles: args.criticalNotificationRoles,
          it_escalation_roles: args.itEscalationRoles,
          order_stall_hours: args.orderStallHours,
          idle_hours: args.idleHours,
          delay_buffer_minutes: args.delayBufferMinutes,
          rain_probability_threshold: args.rainProbabilityThreshold,
          wind_speed_threshold_kmh: args.windSpeedThresholdKmh,
          daily_overtime_hours: args.dailyOvertimeHours,
          break_required_after_hours: args.breakRequiredAfterHours,
          crew_location_stale_minutes: args.crewLocationStaleMinutes,
        });
        return { content: [{ type: "text", text: JSON.stringify(settings) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "list_pending_notifications",
    {
      title: "List Pending Notifications",
      description: "The delivery poller's own query: critical, never delivered, under the retry cap. System-integration tool. Minimum tier: 4.",
      inputSchema: z.object({ ...credentialArg }),
    },
    async ({ credentialJwt }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:list_pending_notifications", 4);
        const notifications = await listPendingNotifications();
        return { content: [{ type: "text", text: JSON.stringify(notifications) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "resolve_notification_recipients",
    {
      title: "Resolve Notification Recipients",
      description:
        "Resolves a notification's recipient_roles_override (or, if unset, the priority-appropriate default from notification_settings) into actual active crew members and their phone numbers. Closes the real gap where recipient_roles_override was only ever a role LABEL, never resolved to a person a poller could actually message. System-integration tool. Minimum tier: 4.",
      inputSchema: z.object({
        ...credentialArg,
        priority: z.enum(["critical", "routine"]),
        recipientRolesOverride: z.array(z.string()).nullable(),
      }),
    },
    async ({ credentialJwt, priority, recipientRolesOverride }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:resolve_notification_recipients", 4);
        const recipients = await resolveNotificationRecipients({ priority, recipientRolesOverride });
        return { content: [{ type: "text", text: JSON.stringify(recipients) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "mark_notification_attempted",
    {
      title: "Mark Notification Attempted",
      description: "Records a delivery attempt, success or failure -- always called separately from mark_notification_delivered. Minimum tier: 4.",
      inputSchema: z.object({ ...credentialArg, id: z.string().uuid() }),
    },
    async ({ credentialJwt, id }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:mark_notification_attempted", 4);
        await markNotificationAttempted(id);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "mark_notification_delivered",
    {
      title: "Mark Notification Delivered",
      description: "Records successful delivery, capturing the WhatsApp message id for later reply-correlation. Minimum tier: 4.",
      inputSchema: z.object({ ...credentialArg, id: z.string().uuid(), whatsappMessageId: z.string().optional() }),
    },
    async ({ credentialJwt, id, whatsappMessageId }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:mark_notification_delivered", 4);
        const notification = await markNotificationDelivered(id, whatsappMessageId);
        if (!notification) return { content: [{ type: "text", text: "Not found" }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(notification) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "list_escalation_candidates",
    {
      title: "List Escalation Candidates",
      description: "Critical, delivered, still-unacknowledged notifications due for another page. System-integration tool. Minimum tier: 4.",
      inputSchema: z.object({ ...credentialArg }),
    },
    async ({ credentialJwt }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:list_escalation_candidates", 4);
        const settings = await getNotificationSettings();
        const candidates = await listEscalationCandidates(settings.escalation_threshold_minutes, settings.max_escalations);
        return { content: [{ type: "text", text: JSON.stringify(candidates) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "escalate_notification",
    {
      title: "Escalate Notification",
      description: "Records a re-page of an unacknowledged critical notification -- flat re-paging of the same recipients, no tiered escalation. Minimum tier: 4.",
      inputSchema: z.object({ ...credentialArg, id: z.string().uuid() }),
    },
    async ({ credentialJwt, id }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:escalate_notification", 4);
        const notification = await escalateNotification(id);
        if (!notification) return { content: [{ type: "text", text: "Not found" }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(notification) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );

  server.registerTool(
    "acknowledge_notification",
    {
      title: "Acknowledge Notification",
      description:
        "Marks a notification acknowledged -- 'a human has seen this and is on it', a separate concept from resolve_alert's 'the problem is actually fixed'. Minimum tier: 2.",
      inputSchema: z.object({ ...credentialArg, id: z.string().uuid(), acknowledgedByCrewMemberId: z.string().uuid() }),
    },
    async ({ credentialJwt, id, acknowledgedByCrewMemberId }) => {
      try {
        await requireCapability(credentialJwt, "mcp:tool:acknowledge_notification", 2);
        const result = await acknowledgeNotification(id, { crewMemberId: acknowledgedByCrewMemberId });
        if (!result.ok) return { content: [{ type: "text", text: `Denied: ${result.reason}` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(result.notification) }] };
      } catch (err) {
        return deniedResult(err);
      }
    },
  );
}
