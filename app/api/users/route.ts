import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../lib/api-response";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../lib/response-security";
import { rateLimitResponse } from "../../lib/rate-limit";
import { verifyTotpAndRenewSecurityConfirmation } from "../../lib/security-session";
import { createManagedUser, deleteManagedUser, listManagedUsers, resendManagedUserActivation, resetManagedUserAuthenticator, updateManagedUser } from "../../lib/user-store";

export const dynamic = "force-dynamic";

function positiveInteger(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function pageSize(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
}

export async function GET(request: Request) {
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "read");
  if (rateLimited) return rateLimited;

  try {
    const search = new URL(request.url).searchParams;
    const users = await listManagedUsers(actor.email, {
      page: positiveInteger(search.get("page")),
      pageSize: pageSize(search.get("pageSize")),
      query: search.get("query") ?? "",
    });
    return secureJson(users);
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    if (!await verifyTotpAndRenewSecurityConfirmation(actor.email, actor.authSessionId, request, body.userCode)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    if (body.action === "reset_authenticator") {
      const reset = await resetManagedUserAuthenticator(actor.email, body);
      return secureJson({ account: reset.user.email, delivery: reset.delivery, expiresAt: reset.expiresAt });
    }
    if (body.action === "resend_activation") {
      const resent = await resendManagedUserActivation(actor.email, body);
      return secureJson(resent);
    }
    const created = await createManagedUser(actor.email, body);
    return secureJson(created, { status: 201 });
  } catch (error) {
    return apiError(error, 400, request);
  }
}

export async function PATCH(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    if (!await verifyTotpAndRenewSecurityConfirmation(actor.email, actor.authSessionId, request, body.userCode)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    const user = await updateManagedUser(actor.email, body);
    return secureJson({ user });
  } catch (error) {
    return apiError(error, 400, request);
  }
}

export async function DELETE(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    if (!await verifyTotpAndRenewSecurityConfirmation(actor.email, actor.authSessionId, request, body.userCode)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    await deleteManagedUser(actor.email, body);
    return secureEmpty();
  } catch (error) {
    return apiError(error, 400, request);
  }
}
