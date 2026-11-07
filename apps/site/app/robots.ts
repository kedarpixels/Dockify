import type { MetadataRoute } from "next";
import { NOINDEX, SITE_URL } from "@/components/seo/config";

/* Open to every crawler, unless SITE_NOINDEX is set for a staging or pre-launch deploy. */
export default function robots(): MetadataRoute.Robots {
  if (NOINDEX) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
