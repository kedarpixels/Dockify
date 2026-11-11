import { CardTitle } from "@/components/card-title";
import { Topbar } from "@/components/shell/topbar";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel, SkelRows } from "@/components/ui/skeleton";

/** The three KPI cells the loaded view shows, as skeletons, so the strip holds its height. */
const KPIS: KpiData[] = [
  { icon: "alert", label: "Firing now", value: <Skel w={32} h={22} />, lead: <Skel w={88} /> },
  { icon: "history", label: "Fired, 24 hours", value: <Skel w={32} h={22} />, lead: <Skel w={120} /> },
  { icon: "pause", label: "Muted rules", value: <Skel w={32} h={22} />, lead: <Skel w={80} /> },
];

/** Route loading state for Alerts: the real head, KPI strip, rules card and history card at their real sizes. */
export function AlertsSkeleton() {
  return (
    <>
      <Topbar trail={["Alerts"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Alerts" lead={<Skel w={320} h={10} />} />
        <Rule />
        <KpiStrip label="Alert summary" cells={KPIS} />
        <Spacer />
        <div className="card al-rules">
          <div className="al-wrap">
            <SkelRows rows={6} height={56} template="24px minmax(0, 1fr) 80px 36px 60px" cols={[24, { w: "44%", lines: 2 }, 56, 36, 56]} label="Loading alert rules" />
          </div>
        </div>
        <Spacer />
        <section className="card al-hist">
          <div className="card-hd">
            <CardTitle id="al-hist-title" icon="history" title="History" sub="Last 90 days, newest first" />
          </div>
          <SkelRows rows={4} height={56} template="24px minmax(0, 1fr) 96px 80px 24px" cols={[24, { w: "40%", lines: 2 }, 72, 64, 14]} label="Loading history" />
        </section>
        <Spacer end />
      </main>
    </>
  );
}
