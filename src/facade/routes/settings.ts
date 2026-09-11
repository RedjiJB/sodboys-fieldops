// Restoring Settings, Slice Q: a real, small settings surface -- not the
// vendored 2320-line multi-domain shell (e-invoicing, translation
// manager, backup/restore have no fit here). Profile is served by the
// already-existing GET /api/v1/users/me/ (auth.ts); this file adds the
// two genuinely new pieces: LLM provider key configuration (the chat
// assistant's one real, already-blocking gap) and self-service password
// change.
import type { Router } from "../router.js";
import { readJsonBody, sendError, sendJson } from "../context.js";
import { requireStaffRole, requireAdminRole } from "../auth.js";
import { getLlmSettings, updateLlmSettings } from "../../domain/llmSettings.js";
import { changeOwnPassword, confirmTotpEnrollment, disableTotp, startTotpEnrollment } from "../../domain/users.js";

type LlmPatchBody = { deepseek_api_key?: string | null; anthropic_api_key?: string | null; openai_api_key?: string | null };
type ChangePasswordBody = { current_password?: string; new_password?: string };
type ConfirmTotpBody = { code?: string };

export function registerSettingsRoutes(router: Router): void {
  // Admin-gated: these are real credentials for a shared service, not a
  // per-user preference -- same gate as the webhook secrets.
  router.get("/api/v1/settings/llm", async (req, res) => {
    try {
      await requireAdminRole(req);
      const settings = await getLlmSettings();
      sendJson(res, 200, {
        deepseek_configured: Boolean(settings.deepseek_api_key || process.env.DEEPSEEK_API_KEY),
        openai_configured: Boolean(settings.openai_api_key || process.env.OPENAI_API_KEY),
        anthropic_configured: Boolean(settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch("/api/v1/settings/llm", async (req, res) => {
    try {
      await requireAdminRole(req);
      const body = await readJsonBody<LlmPatchBody>(req);
      const settings = await updateLlmSettings({
        deepseekApiKey: body.deepseek_api_key,
        anthropicApiKey: body.anthropic_api_key,
        openaiApiKey: body.openai_api_key,
      });
      sendJson(res, 200, {
        deepseek_configured: Boolean(settings.deepseek_api_key || process.env.DEEPSEEK_API_KEY),
        openai_configured: Boolean(settings.openai_api_key || process.env.OPENAI_API_KEY),
        anthropic_configured: Boolean(settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Staff-level: every user changes their own password.
  router.post("/api/v1/users/me/change-password", async (req, res) => {
    try {
      const user = await requireStaffRole(req);
      const body = await readJsonBody<ChangePasswordBody>(req);
      if (!body.current_password || !body.new_password) {
        sendJson(res, 422, { detail: "current_password and new_password are required" });
        return;
      }
      if (body.new_password.length < 8) {
        sendJson(res, 422, { detail: "new_password must be at least 8 characters" });
        return;
      }
      const result = await changeOwnPassword(user.userId, body.current_password, body.new_password);
      if (!result.ok) {
        sendJson(res, result.reason === "wrong_password" ? 401 : 404, {
          detail: result.reason === "wrong_password" ? "Current password is incorrect" : "Not found",
        });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Admin MFA (TOTP), staff-gated like password change -- self-service for
  // any authenticated user's own account, since the secret is personal and
  // only that user's authenticator app should ever hold it. Admins are the
  // priority given their blast radius, but nothing here restricts it to
  // admin-role accounts specifically -- a staff user enabling MFA on their
  // own account is a strict security improvement, never a reason to block.
  router.post("/api/v1/users/me/totp/enroll", async (req, res) => {
    try {
      const user = await requireStaffRole(req);
      const enrollment = await startTotpEnrollment(user.userId);
      if (!enrollment) {
        sendJson(res, 404, { detail: "Not found" });
        return;
      }
      sendJson(res, 200, { secret: enrollment.secret, provisioning_uri: enrollment.provisioningUri });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/api/v1/users/me/totp/confirm", async (req, res) => {
    try {
      const user = await requireStaffRole(req);
      const body = await readJsonBody<ConfirmTotpBody>(req);
      if (!body.code) {
        sendJson(res, 422, { detail: "code is required" });
        return;
      }
      const result = await confirmTotpEnrollment(user.userId, body.code);
      if (!result.ok) {
        sendJson(res, result.reason === "invalid_code" ? 401 : result.reason === "not_found" ? 404 : 422, {
          detail:
            result.reason === "invalid_code"
              ? "Incorrect code"
              : result.reason === "no_pending_secret"
                ? "Call /totp/enroll first"
                : "Not found",
        });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/api/v1/users/me/totp/disable", async (req, res) => {
    try {
      const user = await requireStaffRole(req);
      await disableTotp(user.userId);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
}
