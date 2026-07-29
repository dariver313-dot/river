import { initialAuthenticatorSetup } from "../../../lib/selfhost-auth";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { readLimitedJsonObject } from "../../../lib/request-validation";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";

export const dynamic = "force-dynamic";

/**
 * The setup token arrives in the request body after the browser reads it from
 * the URL fragment. Fragments are never transmitted to Nginx or Next logs.
 */
export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const rateLimited = await anonymousEdgeRateLimitResponse(request);
  if (rateLimited) return rateLimited;
  try {
    const payload = await readLimitedJsonObject(request);
    const token = typeof payload.token === "string" ? payload.token : null;
    const setup = await initialAuthenticatorSetup(token);
    if (!setup) return secureJson({ error: "初始化令牌无效或已失效。" }, { status: 404 });
    return secureJson({ email: setup.email, primarySecret: setup.primarySecret });
  } catch {
    return secureJson({ error: "无法读取初始化信息。" }, { status: 400 });
  }
}
