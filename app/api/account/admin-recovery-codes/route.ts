import { regenerateAdministratorRecoveryCodes } from "../../../lib/account-lifecycle";
import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireApplicationActor } from "../../../lib/api-response";
import { isInitialAdminAccount } from "../../../lib/initial-admin";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { verifyTotpAndRenewSecurityConfirmation } from "../../../lib/security-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireApplicationActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin" || !isInitialAdminAccount(actor.email)) return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    if (!await verifyTotpAndRenewSecurityConfirmation(actor.email, actor.authSessionId, request, body.userCode)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    const recoveryCodes = await regenerateAdministratorRecoveryCodes(actor.email);
    return secureJson({ recoveryCodes });
  } catch (error) {
    return apiError(error, 500, request);
  }
}
