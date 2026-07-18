import { actorRequiredResponse, apiError, requireVaultActor } from "../../lib/api-response";
import { secureJson } from "../../lib/response-security";
import { listVaultSummaryData } from "../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    return secureJson(await listVaultSummaryData(actor.email));
  } catch (error) {
    return apiError(error);
  }
}
