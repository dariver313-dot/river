import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../../lib/api-response";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../../../lib/response-security";
import { deleteVaultItem, getVaultItem, updateVaultItem } from "../../../../lib/vault-store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_: Request, context: RouteContext) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const { id } = await context.params;
    return secureJson({ item: await getVaultItem(actor.email, id) });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const { id } = await context.params;
    const item = await updateVaultItem(actor.email, id, await readJsonObject(request));
    return secureJson({ item });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  const crossOriginResponse = crossOriginRequestResponse(_);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const { id } = await context.params;
    await deleteVaultItem(actor.email, id);
    return secureEmpty();
  } catch (error) {
    return apiError(error, 400);
  }
}
