import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { exportVaultData } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const body = await readJsonObject(request);
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
    if (!approvalId) return secureJson({ error: "缺少批准请求。" }, { status: 400 });
    return secureJson(await exportVaultData(actor.email, approvalId), {
      headers: {
        "Content-Disposition": "attachment; filename=djmima-vault-export.json",
      },
    });
  } catch (error) {
    return apiError(error, 400);
  }
}
