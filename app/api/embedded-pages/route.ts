import { actorRequiredResponse, adminRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../lib/api-response";
import { createEmbeddedPage, deleteEmbeddedPage, listEmbeddedPages, listManagedEmbeddedPagesPage, updateEmbeddedPage } from "../../lib/embedded-pages";
import { listEmbeddedOrigins } from "../../lib/embedded-origins";
import { isInitialAdminAccount } from "../../lib/initial-admin";
import { rateLimitResponse } from "../../lib/rate-limit";
import { crossOriginRequestResponse, secureEmpty, secureJson } from "../../lib/response-security";
import { requireRecentSecurityConfirmation } from "../../lib/security-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "read");
  if (rateLimited) return rateLimited;
  const search = new URL(request.url).searchParams;
  const manage = search.get("manage") === "1";
  if (manage && actor.role !== "admin") return adminRequiredResponse();
  try {
    if (manage) return secureJson({ ...await listManagedEmbeddedPagesPage({ page: Number(search.get("page")) || 1, pageSize: Number(search.get("pageSize")) || 10 }), origins: await listEmbeddedOrigins(), canManageOrigins: isInitialAdminAccount(actor.email) });
    return secureJson({ pages: await listEmbeddedPages(actor.role) });
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;
  try {
    await requireRecentSecurityConfirmation(actor.email, actor.authSessionId, request);
    const body = await readJsonObject(request);
    await createEmbeddedPage(actor.email, body);
    return secureJson({ created: true }, { status: 201 });
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function PATCH(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;
  try {
    await requireRecentSecurityConfirmation(actor.email, actor.authSessionId, request);
    const body = await readJsonObject(request);
    await updateEmbeddedPage(actor.email, body);
    return secureJson({ updated: true });
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function DELETE(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;
  try {
    await requireRecentSecurityConfirmation(actor.email, actor.authSessionId, request);
    const body = await readJsonObject(request);
    await deleteEmbeddedPage(actor.email, body.id);
    return secureEmpty();
  } catch (error) {
    return apiError(error, 500, request);
  }
}
