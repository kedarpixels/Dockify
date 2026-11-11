import { ogVariants, renderOg, type OgCard } from "@/components/seo/og";

const card: OgCard = {
  title: "Run every project on one server, and sleep.",
  accent: "and sleep.",
  kicker: "Open source. Self-hosted. One server.",
  line: "Deploy from GitHub, add domains, run databases and keep tested backups.",
  /* Free and open source: Apache License 2.0 (LICENSE at the repository root). */
  tag: "Free and open source",
};

export function generateImageMetadata() {
  return ogVariants(card.title);
}

export default async function Image({ id }: { id: Promise<string | number> }) {
  return renderOg(card, await id);
}
