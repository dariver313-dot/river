import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { crossOriginRequestResponse, secureEmpty } from "../../../lib/response-security";
import { recordVaultAudit } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    await recordVaultAudit(actor.email, await readJsonObject(request));
    return secureEmpty();
  } catch (error) {
    return apiError(error, 400);
  }
}
