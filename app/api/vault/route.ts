import { actorRequiredResponse, apiError, requireVaultActor } from "../../lib/api-response";
import { secureJson } from "../../lib/response-security";
import { listVaultSummaryData } from "../../lib/vault-store";

export const dynamic = "force-dynamic";

function positiveInteger(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function GET(request: Request) {
  const actor = await requireVaultActor();
  if (!actor) return actorRequiredResponse();

  try {
    const search = new URL(request.url).searchParams;
    return secureJson(await listVaultSummaryData(actor.email, {
      page: positiveInteger(search.get("page")),
      pageSize: 20,
      query: search.get("query") ?? "",
      space: search.get("space") === "个人" || search.get("space") === "公共" ? search.get("space") : "全部",
      category: search.get("category") ?? "全部",
      collection: search.get("collection") === "security" ? "security" : "all",
      securityFocus: search.get("securityFocus") === "weak_password" || search.get("securityFocus") === "reused_password" || search.get("securityFocus") === "missing_two_factor" ? search.get("securityFocus") : "all",
      sortOrder: search.get("sortOrder") === "name" ? "name" : "updated",
    }));
  } catch (error) {
    return apiError(error);
  }
}
