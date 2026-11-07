import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "./config";

/* Structured data. Only facts that hold today: no rating, no review count, no download count and
   no price. The license is Apache-2.0 (the LICENSE file at the repository root). */

const APP = {
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  image: `${SITE_URL}/icon-512.png`,
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Self-hosted deployment platform",
  operatingSystem: "Ubuntu 22.04, Ubuntu 24.04",
  processorRequirements: "amd64 or arm64",
  isAccessibleForFree: true,
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  installUrl: `${SITE_URL}/install`,
  softwareHelp: { "@type": "CreativeWork", url: `${SITE_URL}/docs` },
  featureList: [
    "Deploy GitHub repositories with a Dockerfile, per branch",
    "Zero-downtime deploys for stateless apps, gated on a health check, with automatic rollback",
    "Instant rollback by image, with no rebuild",
    "Encrypted Postgres backups to S3-compatible storage, with scheduled restore tests",
    "Per-app alert rules to the dashboard, Discord, email or a webhook",
    "Domains with Cloudflare DNS and tunnel automation, and TLS",
    "Managed Postgres and Redis, private by default",
  ],
};

const WEBSITE = { "@type": "WebSite", name: SITE_NAME, url: SITE_URL, description: SITE_DESCRIPTION };

/** The site-wide graph, rendered once in the root layout. */
export const SITE_GRAPH = { "@context": "https://schema.org", "@graph": [WEBSITE, APP] };

/** Breadcrumbs for a page under a section, for example Docs, then Backups and restore. */
export function breadcrumbs(trail: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: `${SITE_URL}${t.path}` })),
  };
}

/* "<" becomes the six characters <, so no string in the data can close the script tag. A JSON-LD
   block is data, not script, so the CSP never has to allow it. */
export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
