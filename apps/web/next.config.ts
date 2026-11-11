import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Emails load the Geist faces from this origin and a font fetch is CORS-gated, so the woff2 files answer any origin.
  // Their names are not versioned, so they cache for a day and revalidate instead of being immutable.
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
