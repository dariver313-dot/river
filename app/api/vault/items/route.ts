import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { createVaultItem } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const item = await createVaultItem(actor.email, await readJsonObject(request));
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
