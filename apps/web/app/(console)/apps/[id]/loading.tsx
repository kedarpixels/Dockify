import { CardTitle } from "@/components/card-title";
import { DetailHeadBars, TabStripBars } from "@/components/projects/skeletons";
import { Topbar } from "@/components/shell/topbar";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel, SkelRows } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <Topbar trail={["Apps"]} />
      <main className="page pd" id="main" tabIndex={-1} aria-busy="true">
        <nav className="crumbs" aria-hidden="true">
          <Skel w={160} />
        </nav>
        <SectionHead
          level={1}
          title={
            <span className="pd-title" aria-hidden="true">
              <Skel w={40} h={40} r={10} />
              <Skel w={160} h={24} />
            </span>
          }
          lead={<DetailHeadBars />}
        />
        <Rule />
        <TabStripBars width={720} />
        <Rule />
        <div className="pd-panel" role="status" aria-label="Loading the app">
          <div className="pd-stack">
            <section className="card pd-usage" aria-hidden="true">
              <div className="card-hd">
                <CardTitle id="pd-use-title-loading" icon="cpu" title="Usage" sub="Last 24 hours, share of the app’s limit" />
              </div>
              <div className="meters">
                <div className="meter">
                  <Skel w="40%" />
                  <Skel h={56} r={6} />
                </div>
                <div className="meter">
                  <Skel w="40%" />
                  <Skel h={56} r={6} />
                </div>
              </div>
            </section>
            <div className="pd-ov-pair" aria-hidden="true">
              <section className="card">
                <div className="card-hd">
                  <CardTitle id="pd-last-title-loading" icon="deploy" title="Latest deployment" />
                </div>
                <div className="dep-list">
                  <SkelRows rows={1} template="24px minmax(0, 1fr) 72px" cols={[24, "60%", 56]} label="Loading the latest deployment" />
                </div>
              </section>
              <section className="card">
                <div className="card-hd">
                  <CardTitle id="pd-rt-title-loading" icon="server" title="Runtime" sub="Replicas, ports and limits" />
                </div>
                <SkelRows rows={6} template="minmax(0, 1fr) 140px" cols={["30%", 120]} label="Loading the runtime" />
              </section>
            </div>
          </div>
        </div>
        <Spacer end />
      </main>
    </>
  );
}
