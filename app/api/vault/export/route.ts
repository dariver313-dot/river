import { actorRequiredResponse, apiError, requireVaultActor } from "../../../lib/api-response";
import { secureJson } from "../../../lib/response-security";
import { exportVaultData } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  const approvalId = new URL(request.url).searchParams.get("approvalId") ?? "";
  if (!approvalId) return secureJson({ error: "缺少批准请求。" }, { status: 400 });

  try {
    return secureJson(await exportVaultData(actor.email, approvalId), {
      headers: {
        "Content-Disposition": "attachment; filename=shouyao-vault-export.json",
      },
    });
  } catch (error) {
    return apiError(error, 400);
  }
}
