import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { requireRecentSecurityConfirmation } from "../../../lib/security-session";
import { rotateVaultEncryption } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "maintenance");
  if (rateLimited) return rateLimited;

  try {
    await requireRecentSecurityConfirmation(actor.email, request);
    return secureJson(await rotateVaultEncryption(actor.email, await readJsonObject(request)));
  } catch (error) {
    return apiError(error, 400, request);
  }
}
