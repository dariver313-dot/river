import { actorRequiredResponse, apiError, requireApplicationActor } from "../../../lib/api-response";
import { beginSecuritySession, endSecuritySession } from "../../../lib/security-session";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../../lib/response-security";
import { rateLimitResponse } from "../../../lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireApplicationActor();
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "write");
  if (rateLimited) return rateLimited;

  try {
    const session = await beginSecuritySession(actor.email, request);
    return secureJson({ session: session.status }, { headers: { "Set-Cookie": session.setCookie } });
  } catch (error) {
    return apiError(error, 401, request);
  }
}

export async function DELETE(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireApplicationActor();
  if (!actor) return secureEmpty(204);

  try {
    return secureEmpty(204, { "Set-Cookie": await endSecuritySession(actor.email, request) });
  } catch (error) {
    return apiError(error, 500, request);
  }
}
