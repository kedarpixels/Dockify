import { ogVariants, renderOg, type OgCard } from "@/components/seo/og";

const card: OgCard = {
  title: "Dockify docs",
  accent: "docs",
  kicker: "Docs",
  line: "Everything you need to run Dockify on one server, from install to restore.",
  tag: "/docs",
};

export function generateImageMetadata() {
  return ogVariants(card.title);
}

export default async function Image({ id }: { id: Promise<string | number> }) {
  return renderOg(card, await id);
}
