import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../../lib/api-response";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../../../lib/response-security";
import { rateLimitResponse } from "../../../../lib/rate-limit";
import { requireRecentSecurityConfirmation } from "../../../../lib/security-session";
import { deleteVaultItem, getVaultItem, updateVaultItem } from "../../../../lib/vault-store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "read");
  if (rateLimited) return rateLimited;

  try {
    const { id } = await context.params;
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
    await requireRecentSecurityConfirmation(actor.email, request);
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
    await requireRecentSecurityConfirmation(actor.email, request);
    const { id } = await context.params;
    await deleteVaultItem(actor.email, id);
    return secureEmpty();
  } catch (error) {
    return apiError(error, 400, request);
  }
}
