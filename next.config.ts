import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Server-only packages (image library, Postgres drivers) are loaded as-is, not bundled.
  serverExternalPackages: ["sharp", "pg", "@electric-sql/pglite"],
  poweredByHeader: false,
  // Don't write AGENTS.md / CLAUDE.md into the project folder during `next dev`.
  agentRules: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
