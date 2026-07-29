import { readLimitedJsonObject } from "../../../lib/request-validation";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { consumeLoginChallenge, recordLoginEvent } from "../../../lib/login-risk";
import { createAuthSession, eligibleLoginChallengeAccount } from "../../../lib/selfhost-auth";
import { clearSecuritySessionCookie, createSecuritySession } from "../../../lib/security-session";
import { safeInternalPath } from "../../../lib/safe-navigation";

export const dynamic = "force-dynamic";

function safeReturnTo(value: unknown) {
  return safeInternalPath(typeof value === "string" ? value.slice(0, 2_000) : value);
}

/**
 * Finishes a country-change challenge. The code is bound to an opaque value
 * held only by the browser that started the login and may be used once, so it
 * cannot become a reusable password reset or session token.
 */
export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const rateLimited = await anonymousEdgeRateLimitResponse(request);
  if (rateLimited) return rateLimited;

  try {
    const payload = await readLimitedJsonObject(request);
    const challenge = await consumeLoginChallenge({ id: payload.challengeId, code: payload.code, binding: payload.challengeBinding });
    if (!challenge) return secureJson({ error: "安全确认码无效、已过期或已被使用。请重新登录获取新的确认码。" }, { status: 401 });
    const eligible = await eligibleLoginChallengeAccount(challenge.email);
    if (!eligible) {
      await recordLoginEvent({ email: challenge.email, outcome: "blocked" }).catch(() => undefined);
      return secureJson({ error: "该登录请求已失效，请重新登录。" }, { status: 401 });
    }

    const authSession = await createAuthSession(eligible.email, request);
    const securitySession = await createSecuritySession(eligible.email, authSession.id, request);
    const headers = new Headers();
    headers.append("Set-Cookie", clearSecuritySessionCookie(request));
    headers.append("Set-Cookie", authSession.setCookie);
    headers.append("Set-Cookie", securitySession.setCookie);
    await recordLoginEvent({
      email: eligible.email,
      outcome: "success",
      assessment: { countryCode: challenge.countryCode, available: true, level: "country_change", reasons: ["country_changed"] },
    }).catch(() => undefined);
    return secureJson(
      { next: eligible.mustChangePassword ? "/account/password?first_login=1" : safeReturnTo(payload.returnTo) },
      { headers },
    );
  } catch (error) {
    console.error("djmima_login_challenge_failed", { message: error instanceof Error ? error.message : String(error) });
    return secureJson({ error: "安全确认暂时不可用，请稍后重试。" }, { status: 503 });
  }
}
