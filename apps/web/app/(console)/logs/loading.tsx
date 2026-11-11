import { LoadingRows } from "@/components/logs/logs-view";
import { Topbar } from "@/components/shell/topbar";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <Topbar trail={["Logs"]} />
      <main className="page lx" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Logs" lead={<Skel w={360} h={10} />} />
        <Rule />
        <div className="toolbar lx-filters" aria-hidden="true">
          <Skel w={280} h={36} r={10} className="lx-search" />
          <Skel w={200} h={36} r={10} className="lx-pick" />
          <Skel w={188} h={36} r={10} />
          <Skel w={152} h={36} r={10} className="lx-level" />
          <Skel w={220} h={36} r={10} className="lx-range" />
        </div>
        <Rule />
        <div className="toolbar" aria-hidden="true">
          <Skel w={72} h={10} />
          <Skel w={64} h={10} />
          <span className="lx-keys">
            <Skel w={36} h={36} r={8} />
            <Skel w={36} h={36} r={8} />
            <Skel w={112} h={36} r={8} />
          </span>
        </div>
        <Rule />
        <div className="lx-stage">
          <div className="lx-box">
            <div className="lx-status">
              <LoadingRows />
            </div>
          </div>
        </div>
        <Spacer end />
      </main>
    </>
  );
}
