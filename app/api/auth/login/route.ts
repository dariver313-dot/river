import { readLimitedJsonObject } from "../../../lib/request-validation";
import { anonymousEdgeRateLimitResponse, failedLoginRateLimitPrecheckResponse, failedLoginRateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { createAuthSession, securityEmailForAccount, verifySelfHostedLogin } from "../../../lib/selfhost-auth";
import { clearSecuritySessionCookie, createSecuritySession } from "../../../lib/security-session";
import { assessLoginRisk, issueLoginChallenge, loginRiskMode, recordLoginEvent } from "../../../lib/login-risk";
import { securityEmailConfigured, sendNewCountryChallenge } from "../../../lib/security-email";
import { safeInternalPath } from "../../../lib/safe-navigation";

export const dynamic = "force-dynamic";

function safeReturnTo(value: unknown) {
  return safeInternalPath(typeof value === "string" ? value.slice(0, 2_000) : value);
}

function maskedSecurityEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "安全邮箱";
  const visible = local.length <= 2 ? local.slice(0, 1) : `${local.slice(0, 2)}***`;
  return `${visible}@${domain}`;
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
    const failedLoginPrecheck = await failedLoginRateLimitPrecheckResponse(request, email);
    if (failedLoginPrecheck) return failedLoginPrecheck;
    const authenticated = await verifySelfHostedLogin({ email, password, userCode });
    if (!authenticated) {
      await recordLoginEvent({ email, outcome: "failure" }).catch(() => undefined);
      const failedRateLimit = await failedLoginRateLimitResponse(request, email);
      if (failedRateLimit) return failedRateLimit;
      return secureJson({ error: "登录信息无效或已过期，请检查登录密码和本人验证码后重试。" }, { status: 401 });
    }

    const assessment = await assessLoginRisk(authenticated.email, request);
    const enforceRisk = loginRiskMode() === "enforce";
    // Enforce mode must never silently degrade to an unrestricted login when
    // the local GeoIP file cannot be read or the proxy did not expose a real
    // client address. Observe mode is limited to local development previews.
    if (enforceRisk && (!assessment.available || !assessment.countryCode)) {
      await recordLoginEvent({ email: authenticated.email, outcome: "blocked", assessment }).catch(() => undefined);
      return secureJson({ error: "登录国家暂时无法安全确认，请稍后重试或联系管理员检查本地 GeoIP 与代理配置。" }, { status: 503 });
    }
    if (!authenticated.securityEmailVerified) {
      const authSession = await createAuthSession(authenticated.email, request);
      const securitySession = await createSecuritySession(authenticated.email, authSession.id, request);
      const headers = new Headers();
      headers.append("Set-Cookie", clearSecuritySessionCookie(request));
      headers.append("Set-Cookie", authSession.setCookie);
      headers.append("Set-Cookie", securitySession.setCookie);
      await recordLoginEvent({ email: authenticated.email, outcome: "success", assessment }).catch(() => undefined);
      return secureJson({ next: "/account/security-email?setup=1" }, { headers });
    }
    if (enforceRisk && assessment.level === "country_change") {
      const securityEmail = await securityEmailForAccount(authenticated.email);
      if (!securityEmail || !securityEmailConfigured()) {
        await recordLoginEvent({ email: authenticated.email, outcome: "blocked", assessment }).catch(() => undefined);
        return secureJson({ error: "此登录需要完成安全邮箱确认，但该账号尚未配置可用的安全邮箱。请联系管理员。" }, { status: 403 });
      }

      const challenge = await issueLoginChallenge({ email: authenticated.email, assessment });
      try {
        await sendNewCountryChallenge({
          to: securityEmail,
          code: challenge.code,
          countryCode: assessment.countryCode,
          expiresAt: challenge.expiresAt,
        });
      } catch {
        await recordLoginEvent({ email: authenticated.email, outcome: "blocked", assessment }).catch(() => undefined);
        return secureJson({ error: "安全确认邮件暂时无法发送，请稍后重试或联系管理员。" }, { status: 503 });
      }
      await recordLoginEvent({ email: authenticated.email, outcome: "challenge", assessment });
      return secureJson({
        challengeRequired: true,
        challengeId: challenge.id,
        challengeBinding: challenge.binding,
        securityEmail: maskedSecurityEmail(securityEmail),
        expiresAt: challenge.expiresAt,
      }, { status: 202 });
    }

    // A fresh authentication must not inherit an expired security-session
    // cookie from a prior login; otherwise the first app request is rejected
    // and the browser is sent straight back to /login.
    const authSession = await createAuthSession(authenticated.email, request);
    const securitySession = await createSecuritySession(authenticated.email, authSession.id, request);
    const headers = new Headers();
    headers.append("Set-Cookie", clearSecuritySessionCookie(request));
    headers.append("Set-Cookie", authSession.setCookie);
    headers.append("Set-Cookie", securitySession.setCookie);
    await recordLoginEvent({ email: authenticated.email, outcome: "success", assessment }).catch(() => undefined);
    return secureJson(
      { next: authenticated.mustChangePassword ? "/account/password?first_login=1" : safeReturnTo(payload.returnTo) },
      { headers },
    );
  } catch (error) {
    console.error("djmima_login_failed", { message: error instanceof Error ? error.message : String(error) });
    return secureJson({ error: "登录暂时不可用，请联系系统管理员检查服务器配置。" }, { status: 503 });
  }
}
