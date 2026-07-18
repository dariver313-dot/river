import { actorRequiredResponse, apiError, requireVaultActor } from "../../lib/api-response";
import { listVaultData } from "../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    return Response.json(await listVaultData(actor.email));
  } catch (error) {
    return apiError(error);
  }
}
