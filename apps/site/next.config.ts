import type { NextConfig } from "next";

/* Images and sounds keep for a day and refresh in the background for a week. The installer scripts
   must never be served stale, so they always revalidate. */
const DAY = "public, max-age=86400, stale-while-revalidate=604800";
const FRESH = "public, max-age=0, must-revalidate";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Every page is prerendered; these are the only files the server or the image routes read, so the
  // standalone build carries them and nothing else from the app folder.
  outputFileTracingIncludes: {
    "/docs/**": ["./content/docs/**"],
    "/search.json": ["./content/docs/**"],
    "/changelog": ["./content/releases/**"],
    "/**/opengraph-image*": ["./components/seo/assets/**"],
  },
  async headers() {
    const images = ["/shots/:path*", "/sounds/:path*", "/dockify-logo.png", "/dockify-mark.svg", "/dockify-glyph.svg", "/favicon-16.png", "/favicon-32.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"];
    const scripts = ["/install.sh", "/installer.sh", "/installer.sh.sha256", "/uninstall.sh", "/uninstaller.sh", "/uninstaller.sh.sha256"];
    return [
      ...images.map((source) => ({ source, headers: [{ key: "Cache-Control", value: DAY }] })),
      ...scripts.map((source) => ({ source, headers: [{ key: "Cache-Control", value: FRESH }] })),
    ];
  },
};

export default nextConfig;
