import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { createVaultItem } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const item = await createVaultItem(actor.email, await readJsonObject(request));
    return secureJson({ item }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
