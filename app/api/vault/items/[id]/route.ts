import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../../lib/api-response";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../../../lib/response-security";
import { rateLimitResponse } from "../../../../lib/rate-limit";
import { requireRecentSecurityConfirmation } from "../../../../lib/security-session";
import { deleteVaultItem, getVaultItem, getVaultItemScope, updateVaultItem } from "../../../../lib/vault-store";
import { verifySelfHostedTotp } from "../../../../lib/selfhost-auth";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function requirePublicItemTotp(actor: { email: string; authSessionId: string }, request: Request, body: Record<string, unknown>) {
  await requireRecentSecurityConfirmation(actor.email, actor.authSessionId, request);
  return typeof body.userCode === "string" && await verifySelfHostedTotp(actor.email, body.userCode);
}

export async function GET(request: Request, context: RouteContext) {
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "read");
  if (rateLimited) return rateLimited;

  try {
    const { id } = await context.params;
    // getVaultItem records a signed public_secret_accessed event before it
    // returns any decrypted public credential to this response.
    return secureJson({ item: await getVaultItem(actor.email, id) });
  } catch (error) {
    return apiError(error, 400, request);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "write");
  if (rateLimited) return rateLimited;

  try {
    const { id } = await context.params;
    const body = await readJsonObject(request);
    const scope = await getVaultItemScope(actor.email, id);
    if ((scope.group === "公共" || body.group === "公共") && !await requirePublicItemTotp(actor, request, body)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    const item = await updateVaultItem(actor.email, id, body);
    return secureJson({ item });
  } catch (error) {
    return apiError(error, 400, request);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    const { id } = await context.params;
    const scope = await getVaultItemScope(actor.email, id);
    if (scope.group === "公共" && !await requirePublicItemTotp(actor, request, body)) {
      return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
    }
    await deleteVaultItem(actor.email, id);
    return secureEmpty();
  } catch (error) {
    return apiError(error, 400, request);
  }
}
