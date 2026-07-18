import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../lib/api-response";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../lib/response-security";
import { createManagedUser, deleteManagedUser, listManagedUsers, updateManagedUser } from "../../lib/user-store";

export const dynamic = "force-dynamic";

function positiveInteger(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function GET(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    const search = new URL(request.url).searchParams;
    return secureJson(await listManagedUsers(actor.email, {
      page: positiveInteger(search.get("page")),
      pageSize: 20,
      query: search.get("query") ?? "",
    }));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    const user = await createManagedUser(actor.email, await readJsonObject(request));
    return secureJson({ user }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function PATCH(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    const user = await updateManagedUser(actor.email, await readJsonObject(request));
    return secureJson({ user });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    await deleteManagedUser(actor.email, await readJsonObject(request));
    return secureEmpty();
  } catch (error) {
    return apiError(error, 400);
  }
}
