import { DocsSidebar } from "@/components/docs/sidebar";

/* Docs frame: sidebar, article, on-page TOC, as three ruled columns inside the rails. The header's
   bottom corners carry the nodes where its rule meets the rails, so the frame needs no band on top.
   Search reads /search.json, written once at build time. */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="page docs-page">
      <div className="docs">
        <DocsSidebar />
        {children}
      </div>
    </main>
  );
}
