import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The API and this app are two npm projects in one repository, each with its
 * own lockfile. Turbopack walks up looking for the workspace root, finds the
 * API's lockfile one level above, and picks that — which puts the build output
 * in the wrong place and fails collecting page data. Pinning the root to this
 * directory is the fix; it is not a monorepo and should not be treated as one.
 */
const nextConfig: NextConfig = {
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
