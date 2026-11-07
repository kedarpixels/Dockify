import { ogVariants, renderOg, type OgCard } from "@/components/seo/og";

/* Social card for this route, dark and light. Drawn by components/seo/og.tsx. */
const card: OgCard = {
  title: "Dockify, Coolify, Dokploy and Vercel",
  kicker: "Compare",
  line: "We built Dockify for one job, so it does less than the others.",
  tag: "/compare",
};

export function generateImageMetadata() {
  return ogVariants(card.title);
}

export default async function Image({ id }: { id: Promise<string | number> }) {
  return renderOg(card, await id);
}
