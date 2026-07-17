import { apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { decideApproval, listApprovalRequests, requestExportApproval } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  try {
    return Response.json({ approvals: await listApprovalRequests(actor.email) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST() {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  try {
    const approval = await requestExportApproval(actor.email);
    return Response.json({ approval }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function PATCH(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  try {
    const body = await readJsonObject(request);
    const id = typeof body.id === "string" ? body.id : "";
    const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : null;
    if (!id || !decision) return Response.json({ error: "批准请求无效。" }, { status: 400 });

    await decideApproval(actor.email, id, decision);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error, 400);
  }
}
