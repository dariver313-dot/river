import { completePasswordRecovery, requestPasswordRecovery } from "../../../lib/account-lifecycle";
import { readLimitedJsonObject } from "../../../lib/request-validation";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const rateLimited = await anonymousEdgeRateLimitResponse(request);
  if (rateLimited) return rateLimited;
  let completing = false;
  try {
    const payload = await readLimitedJsonObject(request);
    if (payload.action === "complete") {
      completing = true;
      const recovered = await completePasswordRecovery({ code: payload.code, password: payload.password });
      if (!recovered) return secureJson({ error: "恢复码无效、已过期，或该账号当前不可恢复。" }, { status: 401 });
      return secureJson({ completed: true });
    }
    await requestPasswordRecovery({ account: payload.account });
    return secureJson({ accepted: true });
  } catch {
    // Do not turn mail or account lookup failures into account-existence clues.
    if (completing) {
      return secureJson({ error: "密码恢复未完成。请确认恢复码和新密码后重试。" }, { status: 400 });
    }
    return secureJson({ accepted: true });
  }
}
