import { beginAdministratorRecovery, confirmAdministratorRecovery } from "../../../lib/account-lifecycle";
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
      const confirmed = await confirmAdministratorRecovery({
        recoveryCode: payload.recoveryCode,
        confirmationCode: payload.confirmationCode,
        userCode: payload.userCode,
      });
      if (!confirmed) return secureJson({ error: "恢复码无效、已使用或恢复会话已失效。" }, { status: 401 });
      if (!confirmed.confirmed) return secureJson({ error: confirmed.error }, { status: 400 });
      return secureJson({ completed: true });
    }
    const recovery = await beginAdministratorRecovery({ code: payload.recoveryCode, password: payload.password });
    if (!recovery) return secureJson({ error: "恢复码无效、已使用或当前不可恢复。" }, { status: 401 });
    return secureJson(recovery);
  } catch {
    // This endpoint accepts a recovery factor. Do not reflect configuration or
    // cryptographic failures to an unauthenticated caller.
    return secureJson({ error: "管理员恢复暂时不可用，请稍后重试。" }, { status: 400 });
  }
}
