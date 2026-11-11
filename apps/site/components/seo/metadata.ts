import type { Metadata } from "next";
import { SITE_NAME } from "./config";

/* A page's openGraph replaces the layout's whole object rather than merging into it, so the shared fields are set again here. */

type PageMeta = {
  /** Path from the site root, for example "/install". */
  path: string;
  /** Run through the layout's "%s | Dockify" template unless `absolute` is set. */
  title?: string;
  absolute?: string;
  description?: string;
  type?: "website" | "article";
};

export function pageMetadata({ path, title, absolute, description, type = "website" }: PageMeta): Metadata {
  const full = absolute ?? (title ? `${title} | ${SITE_NAME}` : undefined);
  return {
    title: absolute ? { absolute } : title,
    description,
    alternates: { canonical: path },
    openGraph: { type, siteName: SITE_NAME, locale: "en_US", url: path, title: full, description },
    twitter: { card: "summary_large_image", title: full, description },
  };
}
