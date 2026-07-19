import { crossOriginRequestResponse, secureEmpty } from "../../../lib/response-security";
import { endAuthSession } from "../../../lib/selfhost-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  return secureEmpty(204, { "Set-Cookie": await endAuthSession(request) });
}
