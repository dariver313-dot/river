import { redirect } from "next/navigation";
import { getAuthenticatedUser, signOutRedirectPath } from "./selfhost-session";
import { ensureApplicationUser, isPasswordChangeRequired } from "./lib/user-store";
import VaultClient from "./vault-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const viewer = await getAuthenticatedUser();

  if (!viewer) {
    redirect("/login");
  }

  const account = await ensureApplicationUser(viewer.email);
  if (!account) {
    return <main className="access-pending"><section><span aria-hidden="true">!</span><p className="eyebrow">账户尚未开通</p><h1>请联系系统管理员</h1><p>{viewer.email} 尚未被添加为系统用户，或该账户已被停用。</p><a href={signOutRedirectPath("/login")}>返回登录页</a></section></main>;
  }

  if (await isPasswordChangeRequired(viewer.email)) {
    redirect("/account/password?first_login=1");
  }

  return <VaultClient viewer={{ displayName: viewer.displayName, email: viewer.email, role: account.role }} />;
}
