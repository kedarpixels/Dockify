import { ogVariants, renderOg, type OgCard } from "@/components/seo/og";

const card: OgCard = {
  title: "Install Dockify",
  accent: "Dockify",
  kicker: "Install",
  line: "One command on a fresh Ubuntu server, with HTTPS from the first login.",
  tag: "/install",
};

export function generateImageMetadata() {
  return ogVariants(card.title);
}

export default async function Image({ id }: { id: Promise<string | number> }) {
  return renderOg(card, await id);
}
