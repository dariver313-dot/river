import { apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { createVaultItem } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  try {
    const item = await createVaultItem(actor.email, await readJsonObject(request));
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
