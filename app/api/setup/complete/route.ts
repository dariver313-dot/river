import { readLimitedJsonObject } from "../../../lib/request-validation";
import { apiError } from "../../../lib/api-response";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { completeInitialAuthenticatorSetup } from "../../../lib/selfhost-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const rateLimited = await anonymousEdgeRateLimitResponse(request);
  if (rateLimited) return rateLimited;
  try {
    const payload = await readLimitedJsonObject(request);
    const token = typeof payload.token === "string" ? payload.token : null;
    const password = typeof payload.password === "string" ? payload.password : "";
    const securityEmail = typeof payload.securityEmail === "string" ? payload.securityEmail : "";
    const completed = await completeInitialAuthenticatorSetup(token, password, securityEmail);
    if (!completed) return secureJson({ error: "初始化令牌无效或已失效。" }, { status: 404 });
    return secureJson({ completed: true, recoveryCodes: completed.recoveryCodes });
  } catch (error) {
    return apiError(error, 500, request);
  }
}
