import { readLimitedJsonObject } from "../../../lib/request-validation";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { completeInitialAuthenticatorSetup } from "../../../lib/selfhost-auth";
import { ClientSafeError } from "../../../lib/security-errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  try {
    const payload = await readLimitedJsonObject(request);
    const token = typeof payload.token === "string" ? payload.token : null;
    const password = typeof payload.password === "string" ? payload.password : "";
    const completed = await completeInitialAuthenticatorSetup(token, password);
    if (!completed) return secureJson({ error: "初始化令牌无效或已失效。" }, { status: 404 });
    return secureJson({ completed: true });
  } catch (error) {
    if (error instanceof ClientSafeError) return secureJson({ error: error.message }, { status: error.status });
    return secureJson({ error: "初始化确认未完成。" }, { status: 400 });
  }
}
