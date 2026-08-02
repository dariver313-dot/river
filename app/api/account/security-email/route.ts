import { confirmCurrentSecurityEmailChange, confirmSecurityEmailChange, requestSecurityEmailChange } from "../../../lib/account-lifecycle";
import { actorRequiredResponse, apiError, readJsonObject } from "../../../lib/api-response";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { requireActiveSecuritySession, verifyTotpAndRenewSecurityConfirmation } from "../../../lib/security-session";
import { getAuthenticatedSession } from "../../../selfhost-session";
import { getActiveApplicationActor } from "../../../lib/user-store";

export const dynamic = "force-dynamic";

async function securityEmailActor(request: Request) {
  const session = await getAuthenticatedSession();
  if (!session) return null;
  const actor = await getActiveApplicationActor(session.email);
  if (!actor) return null;
  await requireActiveSecuritySession(actor.email, session.sessionId, request);
  return { ...actor, authSessionId: session.sessionId };
}

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  let actor;
  try {
    actor = await securityEmailActor(request);
  } catch {
    return actorRequiredResponse();
  }
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    if (!await verifyTotpAndRenewSecurityConfirmation(actor.email, actor.authSessionId, request, body.userCode)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    const result = await requestSecurityEmailChange({ account: actor.email, securityEmail: body.securityEmail });
    if (!result) return actorRequiredResponse();
    return secureJson(result);
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function PATCH(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  let actor;
  try {
    actor = await securityEmailActor(request);
  } catch {
    return actorRequiredResponse();
  }
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    if (body.action === "confirm_current") {
      const result = await confirmCurrentSecurityEmailChange({ account: actor.email, securityEmail: body.securityEmail, code: body.code });
      if (!result) return secureJson({ error: "原邮箱确认码无效或已失效，请重新获取。" }, { status: 401 });
      return secureJson(result);
    }
    const result = await confirmSecurityEmailChange({ account: actor.email, securityEmail: body.securityEmail, code: body.code });
    if (!result) return secureJson({ error: "确认码无效或已失效，请重新获取。" }, { status: 401 });
    return secureJson({ updated: true, securityEmail: result.securityEmail, requiresRelogin: result.requiresRelogin });
  } catch (error) {
    return apiError(error, 500, request);
  }
}
