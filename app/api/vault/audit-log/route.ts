import { actorRequiredResponse, adminRequiredResponse, apiError, requireVaultActor } from "../../../lib/api-response";
import { secureJson } from "../../../lib/response-security";
import { listManagementAudit, type ManagementAuditCategory } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

function positiveInteger(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function auditCategory(value: string | null): ManagementAuditCategory {
  if (value === "project" || value === "user" || value === "export") return value;
  return "all";
}

export async function GET(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();
  if (actor.role !== "admin") return adminRequiredResponse();

  try {
    const search = new URL(request.url).searchParams;
    return secureJson(await listManagementAudit(actor.email, {
      page: positiveInteger(search.get("page")),
      pageSize: 20,
      category: auditCategory(search.get("category")),
    }));
  } catch (error) {
    return apiError(error);
  }
}
