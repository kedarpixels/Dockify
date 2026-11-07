import { ogVariants, renderOg, type OgCard } from "@/components/seo/og";

/* Social card for this route, dark and light. Drawn by components/seo/og.tsx. */
const card: OgCard = {
  title: "Changelog",
  kicker: "Releases",
  line: "Versioned releases, newest first. Each entry links its signed release.",
  tag: "/changelog",
};

export function generateImageMetadata() {
  return ogVariants(card.title);
}

export default async function Image({ id }: { id: Promise<string | number> }) {
  return renderOg(card, await id);
}
