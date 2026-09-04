import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships its extensions as .tar.gz assets loaded from disk at runtime.
  // Bundling rewrites those paths and the extension can no longer be found, so
  // it has to stay external. Dev-only dependency; see lib/dev-db.ts.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
