import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "../selfhost-session";
import { ensureApplicationUser } from "../lib/user-store";

export const dynamic = "force-dynamic";

export default async function EmbeddedPagesPage() {
  const viewer = await getAuthenticatedUser();
  if (!viewer) redirect("/login?return_to=%2Fembedded");
  const account = await ensureApplicationUser(viewer.email);
  if (!account) redirect("/login");
  redirect("/?view=embedded");
}
