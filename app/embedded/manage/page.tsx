import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "../../selfhost-session";
import { ensureApplicationUser } from "../../lib/user-store";

export const dynamic = "force-dynamic";

export default async function EmbeddedPageManagerPage() {
  const viewer = await getAuthenticatedUser();
  if (!viewer) redirect("/login?return_to=%2Fembedded%2Fmanage");
  const account = await ensureApplicationUser(viewer.email);
  if (!account || account.role !== "admin") redirect("/embedded");
  redirect("/?view=embedded-manage");
}
