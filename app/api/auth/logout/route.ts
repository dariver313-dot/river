import { crossOriginRequestResponse, secureEmpty } from "../../../lib/response-security";
import { anonymousEdgeRateLimitResponse } from "../../../lib/rate-limit";
import { endAuthSession } from "../../../lib/selfhost-auth";
import { clearSecuritySessionCookie } from "../../../lib/security-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const rateLimited = await anonymousEdgeRateLimitResponse(request);
  if (rateLimited) return rateLimited;
  const headers = new Headers();
  headers.append("Set-Cookie", await endAuthSession(request));
  headers.append("Set-Cookie", clearSecuritySessionCookie(request));
  return secureEmpty(204, headers);
}
