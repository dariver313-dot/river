import { actorRequiredResponse, requireApplicationActor } from "../../../lib/api-response";
import { changeSelfHostedPassword, endAuthSession } from "../../../lib/selfhost-auth";
import { readLimitedJsonObject } from "../../../lib/request-validation";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;

  const viewer = await requireApplicationActor();
  if (!viewer) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, viewer.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    const payload = await readLimitedJsonObject(request);
    const currentPassword = typeof payload.currentPassword === "string" ? payload.currentPassword : "";
    const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
    const userCode = typeof payload.userCode === "string" ? payload.userCode : "";
    const changed = await changeSelfHostedPassword({ email: viewer.email, currentPassword, newPassword, userCode });
    if (!changed) {
      return secureJson({ error: "当前密码或 Google 验证码不正确，请重试。" }, { status: 401 });
    }
    return secureJson(
      { next: "/login?password_changed=1" },
      { headers: { "Set-Cookie": await endAuthSession(request) } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "密码更新未完成，请稍后重试。";
    return secureJson({ error: message }, { status: 400 });
  }
}
