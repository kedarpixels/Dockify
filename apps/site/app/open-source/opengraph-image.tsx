import { ogVariants, renderOg, type OgCard } from "@/components/seo/og";

const card: OgCard = {
  title: "Open source",
  accent: "source",
  kicker: "Open source",
  line: "Apache License 2.0. The whole product in one repository, with no paid tier.",
  tag: "/open-source",
};

export function generateImageMetadata() {
  return ogVariants(card.title);
}

export default async function Image({ id }: { id: Promise<string | number> }) {
  return renderOg(card, await id);
}
