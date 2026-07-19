import { actorRequiredResponse, apiError, requireVaultActor } from "../../lib/api-response";
import { rateLimitResponse } from "../../lib/rate-limit";
import { secureJson } from "../../lib/response-security";
import { listVaultSummaryData } from "../../lib/vault-store";

export const dynamic = "force-dynamic";

function positiveInteger(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function GET(request: Request) {
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "read");
  if (rateLimited) return rateLimited;

  try {
    const search = new URL(request.url).searchParams;
    const requestedSpace = search.get("space");
    const requestedSecurityFocus = search.get("securityFocus");
    return secureJson(await listVaultSummaryData(actor.email, {
      page: positiveInteger(search.get("page")),
      pageSize: 20,
      query: search.get("query") ?? "",
      space: requestedSpace === "个人" || requestedSpace === "公共" ? requestedSpace : "全部",
      category: search.get("category") ?? "全部",
      collection: search.get("collection") === "security" ? "security" : "all",
      securityFocus: requestedSecurityFocus === "weak_password" || requestedSecurityFocus === "reused_password" || requestedSecurityFocus === "missing_two_factor" ? requestedSecurityFocus : "all",
      sortOrder: search.get("sortOrder") === "name" ? "name" : "updated",
    }));
  } catch (error) {
    return apiError(error, 500, request);
  }
}
