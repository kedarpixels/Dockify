import { CardBars } from "@/components/projects/skeletons";
import { Topbar } from "@/components/shell/topbar";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel } from "@/components/ui/skeleton";

/** The four KPI cells the loaded Projects page shows, as bars, so the toolbar sits where it will. */
const KPIS: KpiData[] = [
  { icon: "folder", label: "Projects", value: <Skel w={32} h={22} />, lead: <Skel w={96} /> },
  { icon: "layers", label: "Apps", value: <Skel w={32} h={22} />, lead: <Skel w={104} /> },
  { icon: "deploy", label: "Deploying", value: <Skel w={32} h={22} />, lead: <Skel w={112} /> },
  { icon: "alert", label: "Apps needing attention", value: <Skel w={32} h={22} />, lead: <Skel w={160} /> },
];

export default function Loading() {
  return (
    <>
      <Topbar trail={["Projects"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Projects" lead="Every product on this server, with the apps and databases it runs." />
        <Rule />
        <KpiStrip label="Summary" cells={KPIS} />
        <Spacer />
        <div className="toolbar pj-bar" aria-hidden="true">
          <Skel w={320} h={36} r={10} />
          <Skel w={360} h={36} r={10} />
        </div>
        <Rule />
        <section className="pj-grid" role="status" aria-label="Loading projects">
          <CardBars apps />
          <CardBars apps />
          <CardBars apps />
        </section>
        <Spacer end />
      </main>
    </>
  );
}
