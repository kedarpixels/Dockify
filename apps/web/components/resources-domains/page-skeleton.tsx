import { Topbar } from "@/components/shell/topbar";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel, SkelRows } from "@/components/ui/skeleton";
import { DomainHead } from "./shared";

/* The four KPI cells the loaded Resources page shows, as bars, so the toolbar sits where it will. */
const KPIS: KpiData[] = [
  { icon: "checkCircle", label: "Running", value: <Skel w={32} h={22} />, lead: <Skel w={96} /> },
  { icon: "alert", label: "Needs attention", value: <Skel w={32} h={22} />, lead: <Skel w={140} /> },
  { icon: "server", label: "Memory", value: <Skel w={48} h={22} />, lead: <Skel w={120} /> },
  { icon: "database", label: "Volumes", value: <Skel w={48} h={22} />, lead: <Skel w={88} /> },
];

/* The loaded rows' own grids (resources-domains.css, .rs-row and .dm-row), so nothing shifts sideways either. */
const RESOURCE_ROW = "minmax(0, 1.2fr) 112px minmax(0, 1.4fr) 112px 136px 72px";
const DOMAIN_ROW = "minmax(0, 1.6fr) 168px 136px minmax(0, 1fr) 68px";

export function PageSkeleton({ page }: { page: "resources" | "domains" }) {
  const title = page === "resources" ? "Resources" : "Domains";
  return (
    <>
      <Topbar trail={[title]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title={title} lead={<Skel w={320} h={10} className="rd-skel-lead" />} />
        <Rule />
        {page === "resources" ? (
          <>
            <KpiStrip label="Summary" cells={KPIS} />
            <Spacer />
          </>
        ) : null}
        <div className="toolbar" aria-hidden="true">
          <Skel w={320} h={36} r={10} />
          <Skel w={280} h={36} r={10} />
        </div>
        <Rule />
        <div className="rd-list">
          {page === "resources" ? (
            <>
              <div className="rs-head" aria-hidden="true">
                <span className="rs-col-name">Name</span>
                <span className="rs-col-status">Status</span>
                <span className="rs-col-image">Image</span>
                <span className="rs-col-cpu">CPU</span>
                <span className="rs-col-mem">Memory</span>
                <span className="rs-col-up">Uptime</span>
              </div>
              <SkelRows
                rows={8}
                height={56}
                template={RESOURCE_ROW}
                cols={[{ w: "60%", lines: 2 }, 72, { w: "70%", lines: 2 }, 80, 96, 40]}
                label="Loading resources"
              />
            </>
          ) : (
            <>
              <DomainHead target />
              <SkelRows
                rows={8}
                height={56}
                template={DOMAIN_ROW}
                cols={[{ w: "60%", lines: 2 }, 72, { w: "70%", lines: 2 }, { w: "50%", lines: 2 }, 56]}
                label="Loading domains"
              />
            </>
          )}
        </div>
        <Spacer end />
      </main>
    </>
  );
}
