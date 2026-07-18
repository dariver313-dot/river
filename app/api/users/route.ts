import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../lib/api-response";
import { createManagedUser, listManagedUsers, updateManagedUser } from "../../lib/user-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    return Response.json({ users: await listManagedUsers(actor.email) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    const user = await createManagedUser(actor.email, await readJsonObject(request));
    return Response.json({ user }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function PATCH(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    const user = await updateManagedUser(actor.email, await readJsonObject(request));
    return Response.json({ user });
  } catch (error) {
    return apiError(error, 400);
  }
}
