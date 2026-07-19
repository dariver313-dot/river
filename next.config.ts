import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // The self-hosted server has 2 GB RAM.  One deterministic build worker is
    // both sufficient for this application and avoids memory spikes in Docker.
    cpus: 1,
  },
};

export default nextConfig;
