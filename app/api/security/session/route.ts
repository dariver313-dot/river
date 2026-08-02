import { actorRequiredResponse, apiError, readJsonObject, requireApplicationActor } from "../../../lib/api-response";
import { endSecuritySession, renewRecentSecurityConfirmation, resumeSecuritySession } from "../../../lib/security-session";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../../lib/response-security";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { verifySelfHostedTotp } from "../../../lib/selfhost-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireApplicationActor();
  if (!actor) return actorRequiredResponse();
  // Older, already-open browser tabs may resume an existing security session
  // with an empty POST body. Keep that harmless resume path compatible while
  // continuing to require JSON whenever a new TOTP proof is supplied.
  let body: Record<string, unknown> = {};
  if ((request.headers.get("content-length") ?? "0") !== "0") {
    try {
      body = await readJsonObject(request);
    } catch (error) {
      return apiError(error, 500, request);
    }
  }
  const userCode = typeof body.userCode === "string" ? body.userCode : "";
  const rateLimited = await rateLimitResponse(request, actor.email, userCode ? "sensitive" : "write");
  if (rateLimited) return rateLimited;

  try {
    if (userCode) {
      if (!await verifySelfHostedTotp(actor.email, userCode)) {
        return secureJson({ error: "Google 验证码不正确，请重试。" }, { status: 401 });
      }
      const session = await renewRecentSecurityConfirmation(actor.email, actor.authSessionId, request);
      return secureJson({ session });
    }
    const session = await resumeSecuritySession(actor.email, actor.authSessionId, request);
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
