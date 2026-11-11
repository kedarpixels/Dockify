import { CardBars, DetailHeadBars, TabStripBars } from "@/components/projects/skeletons";
import { Topbar } from "@/components/shell/topbar";
import { Crumbs } from "@/components/ui/crumbs";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <Topbar trail={["Projects"]} />
      <main className="page pd" id="main" tabIndex={-1} aria-busy="true">
        <Crumbs back current={false} items={[{ label: "Projects", href: "/projects" }]} />
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
        <TabStripBars width={560} />
        <Rule />
        <section className="pj-grid" role="status" aria-label="Loading apps">
          <CardBars />
          <CardBars />
          <CardBars />
        </section>
        <Spacer end />
      </main>
    </>
  );
}
