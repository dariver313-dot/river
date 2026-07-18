import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../../lib/api-response";
import { deleteVaultItem, updateVaultItem } from "../../../../lib/vault-store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const { id } = await context.params;
    const item = await updateVaultItem(actor.email, id, await readJsonObject(request));
    return Response.json({ item });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const { id } = await context.params;
    await deleteVaultItem(actor.email, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error, 400);
  }
}
