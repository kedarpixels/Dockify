import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { NOINDEX, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/components/seo/config";
import { JsonLd, SITE_GRAPH } from "@/components/seo/json-ld";
import { TipGuard } from "@/components/ui/tip-guard";
import { themeScript } from "@/lib/theme";
import "./globals.css";
import "./styles/foundation-shared.css";
import "./styles/foundation.css";
import "./styles/site.css";
import "./styles/docs.css";
import "./styles/landing.css";
import "./styles/pages.css";

/* Geist: everything read or clicked. foundation.css maps --font-sans onto it. */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });

/* Geist Mono: code, commands and paths, and the labels in the line drawings (--font-mono). */
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

/* Geist Pixel Square (--font-geist-pixel-square): display type, 18px and up. It is preloaded, so it
   blocks for its short load instead of painting the headline in a fallback face and reflowing. */
const GeistPixelSquare = localFont({
  src: "./fonts/GeistPixel-Square.woff2",
  variable: "--font-geist-pixel-square",
  weight: "500",
  display: "block",
  fallback: ["ui-monospace", "monospace"],
  adjustFontFallback: false,
});

/* Pages set their own title through the template. Icons come from app/icon.png, apple-icon.png
   and favicon.ico; social cards from each route's opengraph-image.tsx. */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: "%s | Dockify" },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: "The Dockify Authors" }],
  creator: "The Dockify Authors",
  formatDetection: { telephone: false, email: false, address: false },
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US" },
  twitter: { card: "summary_large_image" },
  robots: NOINDEX ? { index: false, follow: false } : { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

/* Static: nothing here reads the request, so every page is prerendered at build time. The CSP in
   proxy.ts allows the inline scripts below by their hashes. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${GeistPixelSquare.variable}`} suppressHydrationWarning>
      <head>
        {/* Runs before paint so the stored theme never flashes the wrong palette. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <JsonLd data={SITE_GRAPH} />
      </head>
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
        <TipGuard />
      </body>
    </html>
  );
}
