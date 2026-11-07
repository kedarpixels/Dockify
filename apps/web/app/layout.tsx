import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist } from "next/font/google";
import localFont from "next/font/local";
import { TipGuard } from "@/components/ui/tip-guard";
import { Toaster } from "@/components/ui/toast";
import { NONCE_HEADER } from "@/lib/security-headers";
import { themeScript } from "@/lib/theme";
import "./globals.css";
import "./styles/foundation-shared.css";
import "./styles/foundation.css";
import "./styles/shell.css";
import "./styles/security-release.css";
import "./styles/overview-top.css";
import "./styles/overview-data.css";
import "./styles/projects.css";
import "./styles/deployments.css";
import "./styles/project-detail.css";
import "./styles/resources-domains.css";
import "./styles/server-backups.css";
import "./styles/activity-settings.css";
import "./styles/auth.css";
import "./styles/app-tabs.css";
import "./styles/project-extras.css";
import "./styles/env-table.css";
import "./styles/new-app.css";
import "./styles/alerts.css";
import "./styles/logs.css";
import "./styles/status-page.css";
import "./styles/backups-extras.css";
import "./styles/server-extras.css";
import "./styles/icons.css";

/* Geist: everything read or clicked. foundation.css maps --font-sans and --font-mono onto it. */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });

/* Geist Pixel Square (--font-geist-pixel-square): display type, 18px and up. Only this one face
   is loaded, so the other pixel faces in the geist package are never preloaded. */
const GeistPixelSquare = localFont({
  src: "./fonts/GeistPixel-Square.woff2",
  variable: "--font-geist-pixel-square",
  weight: "500",
  fallback: ["ui-monospace", "monospace"],
  adjustFontFallback: false,
});

const fontVariables = `${geist.variable} ${GeistPixelSquare.variable}`;

/* A private console: kept out of search engines. Public status pages opt back in. */
export const metadata: Metadata = {
  title: { default: "Dockify", template: "%s | Dockify" },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The per-request CSP nonce proxy.ts set; the inline theme script runs only with it.
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        {/* Runs before paint so the stored theme never flashes the wrong palette. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <Toaster />
        <TipGuard />
      </body>
    </html>
  );
}
