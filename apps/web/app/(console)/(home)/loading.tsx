import { CardTitle } from "@/components/card-title";
import { CardBars } from "@/components/projects/skeletons";
import { Topbar } from "@/components/shell/topbar";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel } from "@/components/ui/skeleton";

/** The four KPI cells the loaded Overview shows, as bars, so the strip holds its height. */
const KPIS: KpiData[] = [
  { icon: "checkCircle", label: "Healthy apps", value: <Skel w={48} h={22} />, lead: <Skel w={96} /> },
  { icon: "deploy", label: "Deployments, 30 days", value: <Skel w={48} h={22} />, lead: <Skel w={88} /> },
  { icon: "clock", label: "Deployments today", value: <Skel w={32} h={22} />, lead: <Skel w={72} /> },
  { icon: "alert", label: "Failure rate, 30 days", value: <Skel w={56} h={22} />, lead: <Skel w={120} /> },
];

export default function Loading() {
  return (
    <>
      <Topbar trail={["Overview"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Overview" lead={<Skel w={280} h={10} />} className="ov-head" />
        <Rule />
        <KpiStrip label="Key numbers" cells={KPIS} />
        <Spacer />
        <section className="card ovp" aria-label="Loading projects">
          <div className="card-hd ovp-hd-row">
            <CardTitle id="proj-title-loading" icon="folder" title="Projects" sub="Health, last deploy" />
          </div>
          <div className="ovp-mask">
            <div className="ovp-track">
              <CardBars />
              <CardBars />
              <CardBars />
            </div>
          </div>
        </section>
        <Spacer />
        <section className="card heat-card" aria-label="Loading deploy activity">
          <div className="card-hd">
            <CardTitle id="heat-title-loading" icon="bars" title="Deploy activity" sub="Deployments per day, this year" />
          </div>
          <div className="heat-main" role="status" aria-label="Loading deploy activity">
            <Skel h={128} r={6} />
          </div>
        </section>
        <Spacer end />
      </main>
    </>
  );
}
