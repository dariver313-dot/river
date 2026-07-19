import { actorRequiredResponse, apiError, readJsonObject, requireVaultActor } from "../../../lib/api-response";
import { crossOriginRequestResponse, secureJson } from "../../../lib/response-security";
import { rateLimitResponse } from "../../../lib/rate-limit";
import { requireRecentSecurityConfirmation } from "../../../lib/security-session";
import { decideApproval, listApprovalRequests, requestExportApproval } from "../../../lib/vault-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "read");
  if (rateLimited) return rateLimited;

  try {
    return secureJson({ approvals: await listApprovalRequests(actor.email) });
  } catch (error) {
    return apiError(error, 500, request);
  }
}

export async function POST(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    await requireRecentSecurityConfirmation(actor.email, request);
    const approval = await requestExportApproval(actor.email);
    return secureJson({ approval }, { status: 201 });
  } catch (error) {
    return apiError(error, 400, request);
  }
}

export async function PATCH(request: Request) {
  const crossOriginResponse = crossOriginRequestResponse(request);
  if (crossOriginResponse) return crossOriginResponse;
  const actor = await requireVaultActor(request);
  if (!actor) return actorRequiredResponse();
  const rateLimited = await rateLimitResponse(request, actor.email, "sensitive");
  if (rateLimited) return rateLimited;

  try {
    await requireRecentSecurityConfirmation(actor.email, request);
    const body = await readJsonObject(request);
    const id = typeof body.id === "string" ? body.id : "";
    const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : null;
    if (!id || !decision) return secureJson({ error: "批准请求无效。" }, { status: 400 });

    await decideApproval(actor.email, id, decision);
    return secureJson({ ok: true });
  } catch (error) {
    return apiError(error, 400, request);
  }
}
