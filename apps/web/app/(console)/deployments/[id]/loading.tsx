import { CardTitle } from "@/components/card-title";
import { Topbar } from "@/components/shell/topbar";
import { Crumbs } from "@/components/ui/crumbs";
import { Corners, Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel, SkelRows } from "@/components/ui/skeleton";

/** The Details grid's labels, in the loaded order, over bars where the values will be. */
const META: Array<[label: string, width: number]> = [
  ["Project", 96],
  ["App", 80],
  ["Environment", 88],
  ["Branch", 72],
  ["Commit", 64],
  ["Trigger", 48],
  ["Started", 64],
  ["Duration", 48],
  ["Actor", 96],
];

/** A build's steps, from queued to the health check. */
const STEPS = 7;

/**
 * Route loading state for one deployment, in the page's own order: the Details card, then Steps,
 * then the Build log, each at its real size.
 */
export default function Loading() {
  return (
    <>
      <Topbar trail={["Deployments", "Deployment"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <Crumbs back current={false} items={[{ label: "Deployments", href: "/deployments" }]} />
        <SectionHead
          level={1}
          className="dpd-head"
          title={
            <>
              <span className="sr">Loading deployment</span>
              <Skel w={160} h={24} />
            </>
          }
          lead={<Skel w={360} h={10} />}
        />
        <Rule />
        <section className="card dpd-meta-card" aria-labelledby="dpd-meta-title">
          <div className="card-hd">
            <CardTitle id="dpd-meta-title" icon="info" title="Details" sub="Where it came from and how long it took" />
          </div>
          <dl className="dpd-meta" aria-hidden="true">
            {META.map(([label, w]) => (
              <div key={label} className="kv dpd-meta-cell">
                <dt className="kv-label">{label}</dt>
                <dd className="kv-value dpd-meta-value">
                  <Skel w={w} />
                  <Corners />
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <Spacer />
        <section className="card dpd-steps-card" aria-labelledby="dpd-steps-title">
          <div className="card-hd">
            <CardTitle id="dpd-steps-title" icon="layers" title="Steps" sub={<Skel w={120} />} />
          </div>
          <ol className="dpd-steps" style={{ "--steps": STEPS } as React.CSSProperties} aria-hidden="true">
            {Array.from({ length: STEPS }, (_, i) => (
              <li key={i} className="dpd-step">
                <Corners />
                <Skel w={24} h={24} r={8} />
                <span className="skel-two">
                  <Skel w={72} h={10} />
                  <Skel w={48} />
                </span>
              </li>
            ))}
          </ol>
        </section>
        <Spacer />
        <section className="card" aria-labelledby="dpd-log-title">
          <div className="card-hd">
            <CardTitle id="dpd-log-title" icon="logs" title="Build log" sub={<Skel w={96} />} />
          </div>
          <div className="lg">
            <div className="toolbar lg-tools" aria-hidden="true">
              <Skel w={320} h={36} r={10} />
              <span className="lg-keys lg-keys-end">
                <Skel w={36} h={36} r={8} />
                <Skel w={36} h={36} r={8} />
                <Skel w={112} h={36} r={8} />
              </span>
            </div>
            <Rule />
            <div className="lg-box">
              <SkelRows rows={12} height={20} template="32px 72px minmax(0, 1fr)" cols={[32, 64, "58%"]} label="Loading the build log" />
            </div>
          </div>
        </section>
        <Spacer end />
      </main>
    </>
  );
}
