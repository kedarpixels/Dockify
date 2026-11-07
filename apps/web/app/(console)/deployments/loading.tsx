import { DEPLOY_ROW_BARS, DEPLOY_ROW_TEMPLATE } from "@/components/deployments/skeleton";
import { Topbar } from "@/components/shell/topbar";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel, SkelRows } from "@/components/ui/skeleton";

/** The four KPI cells the loaded page shows, as bars, so the strip holds its height. */
const KPIS: KpiData[] = [
  { icon: "deploy", label: "In flight", value: <Skel w={32} h={22} />, lead: <Skel w={120} /> },
  { icon: "checkCircle", label: "Succeeded, 24 hours", value: <Skel w={32} h={22} />, lead: <Skel w={136} /> },
  { icon: "alert", label: "Failed, 24 hours", value: <Skel w={32} h={22} />, lead: <Skel w={136} /> },
  { icon: "clock", label: "Build time", value: <Skel w={56} h={22} />, lead: <Skel w={128} /> },
];

/** Route loading state: the real head, the KPI strip, the toolbar and the feed's rows at their real sizes. */
export default function Loading() {
  return (
    <>
      <Topbar trail={["Deployments"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Deployments" lead={<Skel w={320} h={10} />} />
        <Rule />
        <KpiStrip label="Deployment numbers" cells={KPIS} />
        <Spacer />
        <div className="toolbar dpl-tools" aria-hidden="true">
          <Skel w={320} h={36} r={10} />
          <Skel w={360} h={36} r={10} />
          <Skel w={220} h={36} r={10} className="dpl-select" />
        </div>
        <Rule />
        <section className="dpl-feed" aria-label="Deployments">
          <div className="dep-list">
            <SkelRows rows={8} label="Loading deployments" template={DEPLOY_ROW_TEMPLATE} cols={DEPLOY_ROW_BARS} />
          </div>
        </section>
        <Spacer end />
      </main>
    </>
  );
}
