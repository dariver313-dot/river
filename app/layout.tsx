import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const incomingHeaders = await headers();
  const host = incomingHeaders.get("host") ?? "localhost:3000";
  const configuredOrigin = process.env.DJMIMA_PUBLIC_ORIGIN?.trim();
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const origin = configuredOrigin && /^https?:\/\//.test(configuredOrigin) ? configuredOrigin.replace(/\/$/, "") : `${protocol}://${host}`;
  const title = "djmima｜个人账号与密码安全中心";
  const description = "集中管理账号、密码与验证器代码，并通过权限与审计记录保护敏感信息。";

  return {
    title,
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_CN",
      images: [{ url: `${origin}/og-djmima.png`, width: 1200, height: 630, alt: "djmima 密码管理平台界面预览" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og-djmima.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
