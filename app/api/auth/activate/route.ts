import { beginAccountActivation, confirmAccountActivation } from "../../../lib/account-lifecycle";
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
      const confirmed = await confirmAccountActivation({ code: payload.code, userCode: payload.userCode });
      if (!confirmed) return secureJson({ error: "激活确认无效或已失效，请联系管理员重新发送激活码。" }, { status: 401 });
      if (!confirmed.confirmed) return secureJson({ error: confirmed.error }, { status: 400 });
      return secureJson({ completed: true });
    }
    const activation = await beginAccountActivation({ code: payload.code, password: payload.password });
    if (!activation) return secureJson({ error: "激活码无效、已过期，或账号无法继续激活。" }, { status: 401 });
    return secureJson(activation);
  } catch (error) {
    return secureJson({ error: error instanceof Error ? error.message : "激活暂时不可用。" }, { status: 400 });
  }
}
