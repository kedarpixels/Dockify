import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/components/seo/config";

/* Web app manifest: name, colours and the dashboard's own app icons (public/icon-*.png). The
   maskable icon is the mark on a white canvas, the same treatment as the apple icon, with the whale
   inside the safe zone. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "browser",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
