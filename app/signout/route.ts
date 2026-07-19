import { NextResponse } from "next/server";
import { endAuthSession } from "../lib/selfhost-auth";

export const dynamic = "force-dynamic";

function safeReturnTo(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/login";
}

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL(safeReturnTo(new URL(request.url).searchParams.get("return_to")), request.url));
  response.headers.set("Set-Cookie", await endAuthSession(request));
  response.headers.set("Cache-Control", "no-store, max-age=0, private");
  return response;
}
