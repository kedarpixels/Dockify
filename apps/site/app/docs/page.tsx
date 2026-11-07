import { DocPage, docMetadata } from "@/components/docs/doc-page";

export const generateMetadata = () => docMetadata("index");

export default function DocsHome() {
  return <DocPage slug="index" />;
}
