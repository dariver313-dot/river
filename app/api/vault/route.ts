import { apiError, requireVaultActor } from "../../lib/api-response";
import { listVaultData } from "../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  try {
    return Response.json(await listVaultData(actor.email));
  } catch (error) {
    return apiError(error);
  }
}
