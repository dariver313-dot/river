import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { requireRecentSecurityConfirmation } from "../../../lib/security-session";
import { createVaultItem } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "write");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    if (body.group === "公共") await requireRecentSecurityConfirmation(actor.email, request);
    const item = await createVaultItem(actor.email, body);
    return secureJson({ item }, { status: 201 });
  } catch (error) {
    return apiError(error, 400, request);
  }
}
