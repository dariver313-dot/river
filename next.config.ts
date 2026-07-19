import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
        ],
      },
      {
        source: "/setup",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0, private" },
          { key: "Pragma", value: "no-cache" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
  experimental: {
    // The self-hosted server has 2 GB RAM.  One deterministic build worker is
    // both sufficient for this application and avoids memory spikes in Docker.
    cpus: 1,
  },
};

export default nextConfig;
