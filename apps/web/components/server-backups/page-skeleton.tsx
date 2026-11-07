import { CardTitle } from "@/components/card-title";
import type { IconName } from "@/components/icon";
import { Topbar } from "@/components/shell/topbar";
import { KpiCell, KpiStrip, type KpiData } from "@/components/ui/kpi";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel, SkelRows } from "@/components/ui/skeleton";

/* Route loading states for /server and /backups: the real heads, cells and cards at their loaded
   sizes, with bars where the figures and rows will land, so nothing jumps when data arrives. */

const METRICS: Array<{ icon: IconName; label: string }> = [
  { icon: "cpu", label: "CPU" },
  { icon: "layers", label: "Memory" },
  { icon: "box", label: "Disk" },
  { icon: "activity", label: "Network" },
];

export function ServerSkeleton() {
  return (
    <>
      <Topbar trail={["Server"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Server" lead={<Skel w={280} h={10} />} />
        <Rule />
        <section className="kpi" aria-label="Host metrics">
          <div className="kpi-grid sb-metrics" data-cols="2">
            {METRICS.map((m) => (
              <KpiCell key={m.label} cell={{ icon: m.icon, label: m.label, value: <Skel w={64} h={22} />, lead: <Skel w={120} /> }}>
                <div className="sb-trend">
                  <Skel h="100%" r={8} />
                </div>
                <div className="sb-trend-ft">
                  <Skel w={160} />
                </div>
              </KpiCell>
            ))}
          </div>
        </section>
        <Spacer />
        <section className="card sb-disk" aria-busy="true">
          <div className="card-hd">
            <CardTitle id="sb-disk-skel" icon="pie" title="Disk breakdown" sub={<Skel w={120} />} />
          </div>
          <div className="sb-disk-total">
            <Skel h={12} r={6} />
            <Skel w={320} />
          </div>
        </section>
        <Spacer />
        <div className="split" data-stretch="true">
          <section className="card sb-svc">
            <div className="card-hd">
              <CardTitle id="sb-svc-skel" icon="activity" title="Services" sub={<Skel w={140} />} />
            </div>
            <div className="sb-svc-list">
              <SkelRows rows={5} template="24px minmax(0, 1fr) 56px 88px" cols={[24, "45%", 40, 72]} label="Loading services" />
            </div>
          </section>
          <div className="col">
            <section className="card sb-sys">
              <div className="card-hd">
                <CardTitle id="sb-sys-skel" icon="info" title="System" sub="What this server runs" />
              </div>
              <SkelRows rows={6} height={36} template="minmax(0, 1fr) 120px" cols={["40%", 96]} label="Loading system facts" />
            </section>
          </div>
        </div>
        <Spacer end />
      </main>
    </>
  );
}

const BACKUP_KPIS: KpiData[] = [
  { icon: "history", label: "Last backup", value: <Skel w={72} h={22} />, lead: <Skel w={140} /> },
  { icon: "checkCircle", label: "Success rate, 30 days", value: <Skel w={56} h={22} />, lead: <Skel w={110} /> },
  { icon: "archive", label: "Total size", value: <Skel w={56} h={22} />, lead: <Skel w={130} /> },
  { icon: "calendar", label: "Next scheduled", value: <Skel w={72} h={22} />, lead: <Skel w={150} /> },
];

export function BackupsSkeleton() {
  return (
    <>
      <Topbar trail={["Backups"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Backups" lead={<Skel w={300} h={10} />} />
        <Rule />
        <KpiStrip label="Backup summary" cells={BACKUP_KPIS} />
        <Spacer />
        <section className="card sb-sched">
          <div className="card-hd">
            <CardTitle id="sb-sched-skel" icon="calendar" title="Schedules" sub={<Skel w={160} />} />
          </div>
          <div className="sb-sched-wrap">
            <SkelRows rows={3} height={56} template="24px minmax(0, 1fr) minmax(0, 1fr) 160px 36px" cols={[24, { w: "50%", lines: 2 }, "60%", { w: 96, lines: 2 }, 36]} label="Loading schedules" />
          </div>
        </section>
        <Spacer />
        <section className="card sb-hist">
          <div className="card-hd">
            <CardTitle id="sb-hist-skel" icon="history" title="Backup history" sub="Last 30 days, newest first, times in UTC" />
          </div>
          <div className="sb-hist-list">
            <SkelRows rows={6} template="24px 72px minmax(0, 1fr) minmax(0, 1.2fr) 80px 96px" cols={[24, 48, "50%", "60%", 56, 80]} label="Loading backup history" />
          </div>
        </section>
        <Spacer end />
      </main>
    </>
  );
}
