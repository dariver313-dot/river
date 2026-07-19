import { readLimitedJsonObject } from "../../../lib/request-validation";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { createAuthSession, verifySelfHostedLogin } from "../../../lib/selfhost-auth";

export const dynamic = "force-dynamic";

function safeReturnTo(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 2_000);
}

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const rateLimited = await anonymousEdgeRateLimitResponse(request);
  if (rateLimited) return rateLimited;

  try {
    const payload = await readLimitedJsonObject(request);
    const email = typeof payload.email === "string" ? payload.email : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    const userCode = typeof payload.userCode === "string" ? payload.userCode : "";
    const authenticated = await verifySelfHostedLogin({ email, password, userCode });
    if (!authenticated) {
      return secureJson({ error: "登录信息无效或已过期，请检查登录密码和本人验证码后重试。" }, { status: 401 });
    }

    return secureJson(
      { next: authenticated.mustChangePassword ? "/account/password?first_login=1" : safeReturnTo(payload.returnTo) },
      { headers: { "Set-Cookie": await createAuthSession(authenticated.email, request) } },
    );
  } catch (error) {
    console.error("djmima_login_failed", { message: error instanceof Error ? error.message : String(error) });
    return secureJson({ error: "登录暂时不可用，请联系系统管理员检查服务器配置。" }, { status: 503 });
  }
}
