import { apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { inviteVaultMember, removeVaultMember } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  try {
    const member = await inviteVaultMember(actor.email, await readJsonObject(request));
    return Response.json({ member }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return Response.json({ error: "请先完成安全登录。" }, { status: 401 });

  try {
    const body = await readJsonObject(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return Response.json({ error: "缺少协作人邮箱。" }, { status: 400 });
    await removeVaultMember(actor.email, email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error, 400);
  }
}
