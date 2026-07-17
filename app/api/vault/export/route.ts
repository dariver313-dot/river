import { apiError, requireVaultActor } from "../../../lib/api-response";
import { exportVaultData } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  const approvalId = new URL(request.url).searchParams.get("approvalId") ?? "";
  if (!approvalId) return Response.json({ error: "缺少批准请求。" }, { status: 400 });

  try {
    return Response.json(await exportVaultData(actor.email, approvalId), {
      headers: {
        "Content-Disposition": "attachment; filename=shouyao-vault-export.json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error, 400);
  }
}
