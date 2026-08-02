import { actorRequiredResponse, apiError, readJsonObject, requireApplicationActor } from "../../../lib/api-response";
import { updateApplicationProfile } from "../../../lib/user-store";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireApplicationActor();
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "write");
  if (rateLimited) return rateLimited;

  try {
    const body = await readJsonObject(request);
    const profile = await updateApplicationProfile(actor.email, {
      displayName: body.displayName,
      avatarStyle: body.avatarStyle,
    });
    if (!profile) return actorRequiredResponse();
    return secureJson({ profile });
  } catch (error) {
    return apiError(error, 500, request);
  }
}
