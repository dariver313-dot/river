import { readLimitedJsonObject } from "../../../lib/request-validation";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { completeInitialAuthenticatorSetup } from "../../../lib/selfhost-auth";
import { ClientSafeError } from "../../../lib/security-errors";

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
    if (error instanceof ClientSafeError) return secureJson({ error: error.message }, { status: error.status });
    return secureJson({ error: "初始化确认未完成。" }, { status: 400 });
  }
}
