import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The transactional emails load the Geist faces with @font-face from this dashboard's origin (mail
  // clients and the sandboxed preview iframe). A font fetch is CORS-gated, so the two woff2 files
  // answer any origin. The names are not versioned, so they cache for a day and then revalidate
  // rather than being pinned as immutable.
  async headers() {
    return [
      {
        source: "/:font(geist-sans.woff2|geist-pixel.woff2)",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
      },
    ];
  },
};

export default nextConfig;
