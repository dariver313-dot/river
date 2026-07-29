import { beginAuthenticatorReset, confirmAuthenticatorReset } from "../../../lib/account-lifecycle";
import { readLimitedJsonObject } from "../../../lib/request-validation";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const rateLimited = await anonymousEdgeRateLimitResponse(request);
  if (rateLimited) return rateLimited;
  try {
    const payload = await readLimitedJsonObject(request);
    if (payload.action === "confirm") {
      const result = await confirmAuthenticatorReset({ code: payload.code, userCode: payload.userCode });
      if (!result) return secureJson({ error: "恢复确认无效或已失效，请联系管理员重新发起。" }, { status: 401 });
      if (!result.confirmed) return secureJson({ error: result.error }, { status: 400 });
      return secureJson({ completed: true });
    }
    const reset = await beginAuthenticatorReset({ code: payload.code });
    if (!reset) return secureJson({ error: "恢复码无效、已过期，或该账号当前不可恢复。" }, { status: 401 });
    return secureJson(reset);
  } catch (error) {
    return secureJson({ error: error instanceof Error ? error.message : "验证器恢复暂时不可用。" }, { status: 400 });
  }
}
