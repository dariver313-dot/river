import { redirect } from "next/navigation";
import { getChatGPTUser } from "./chatgpt-auth";
import VaultClient from "./vault-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const viewer = await getChatGPTUser();

  if (!viewer) {
    redirect("/login");
  }

  return <VaultClient viewer={{ displayName: viewer.displayName, email: viewer.email }} />;
}
