import { regenerateAdministratorRecoveryCodes } from "../../../lib/account-lifecycle";
import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireApplicationActor } from "../../../lib/api-response";
import { isInitialAdminAccount } from "../../../lib/initial-admin";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { requireRecentSecurityConfirmation } from "../../../lib/security-session";
import { verifySelfHostedTotp } from "../../../lib/selfhost-auth";

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
    await requireRecentSecurityConfirmation(actor.email, actor.authSessionId, request);
    const body = await readJsonObject(request);
    if (typeof body.userCode !== "string" || !await verifySelfHostedTotp(actor.email, body.userCode)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    const recoveryCodes = await regenerateAdministratorRecoveryCodes(actor.email);
    return secureJson({ recoveryCodes });
  } catch (error) {
    return apiError(error, 400, request);
  }
}
