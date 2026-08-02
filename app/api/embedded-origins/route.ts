import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../lib/api-response";
import { addEmbeddedOrigin, deleteEmbeddedOrigin, listEmbeddedOrigins } from "../../lib/embedded-origins";
import { isInitialAdminAccount } from "../../lib/initial-admin";
import { rateLimitResponse } from "../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../lib/response-security";
import { verifyTotpAndRenewSecurityConfirmation } from "../../lib/security-session";

export const dynamic = "force-dynamic";

function initialAdminRequiredResponse() {
  return secureJson({ error: "可信来源会扩大整个系统的可嵌入范围，只有初始管理员可以管理。" }, { status: 403 });
}

async function requireInitialAdminTotp(request: Request) {
  const actor = await requireVaultActor(request);
  if (!actor) return { actor: null, response: actorRequiredResponse() };
  if (actor.role !== "admin") return { actor: null, response: adminRequiredResponse() };
  if (!isInitialAdminAccount(actor.email)) return { actor: null, response: initialAdminRequiredResponse() };
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return { actor: null, response: rateLimited };
  const body = await readJsonObject(request);
  if (!await verifyTotpAndRenewSecurityConfirmation(actor.email, actor.authSessionId, request, body.userCode)) {
    return { actor: null, response: secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 }) };
  }
  return { actor, body, response: null };
}

export async function GET(request: Request) {
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "read");
  if (rateLimited) return rateLimited;
  try {
    return secureJson({ origins: await listEmbeddedOrigins(), canManage: isInitialAdminAccount(actor.email) });
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  try {
    const result = await requireInitialAdminTotp(request);
    if (result.response || !result.actor || !result.body) return result.response!;
    return secureJson({ origins: await addEmbeddedOrigin(result.actor.email, result.body.origin) }, { status: 201 });
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function DELETE(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  try {
    const result = await requireInitialAdminTotp(request);
    if (result.response || !result.actor || !result.body) return result.response!;
    return secureJson({ origins: await deleteEmbeddedOrigin(result.actor.email, result.body.origin) });
  } catch (error) {
    return apiError(error, 500, request);
  }
}
