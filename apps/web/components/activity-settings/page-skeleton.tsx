import { Icon } from "@/components/icon";
import { Topbar } from "@/components/shell/topbar";
import { Node, Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Skel, SkelRows } from "@/components/ui/skeleton";
import { SECTION_GROUPS } from "./sections";

/* Bars sit where the controls and rows will land, so nothing jumps when data arrives. */

/** The loaded event row's grid (activity-view.tsx, SKEL_TEMPLATE). */
const EVENT_ROW = "24px minmax(0, 1fr) 96px 72px 28px";

export function ActivitySkeleton() {
  return (
    <>
      <Topbar trail={["Activity"]} />
      <main className="page act" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Activity" lead="Every deploy, config change, sign-in and system job on this server, newest first." />
        <Rule />
        <div className="toolbar" aria-hidden="true">
          <Skel w={320} h={36} r={10} />
          <Skel w={360} h={36} r={10} />
          <Skel w={160} h={36} r={10} />
        </div>
        <Rule />
        <section className="card act-card" aria-label="Activity log" aria-busy="true">
          <div className="act-list">
            <SkelRows rows={8} template={EVENT_ROW} cols={[24, "60%", 96, 48]} label="Loading activity" />
          </div>
        </section>
        <Spacer end />
      </main>
    </>
  );
}

/** No nav row is current yet: the section comes from the address once the page renders. */
export function SettingsSkeleton() {
  return (
    <>
      <Topbar trail={["Settings"]} />
      <main className="page" id="main" tabIndex={-1} aria-busy="true">
        <SectionHead level={1} title="Settings" lead="Your account, your team and how this Dockify instance behaves." />
        <Rule />
        <div className="set-layout">
          <div className="set-snav" aria-hidden="true">
            <Node pos="tr" />
            {SECTION_GROUPS.map((g) => (
              <div key={g.label} className="set-snav-group">
                <p className="set-snav-hd">{g.label}</p>
                <ul className="set-snav-list">
                  {g.sections.map((s) => (
                    <li key={s.id}>
                      <span className="set-snav-item">
                        <Icon name={s.icon} />
                        <span className="set-snav-label">{s.label}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="set-snav-foot">
              <Node pos="br" />
              <Skel w={96} />
            </div>
          </div>
          <section className="set-main" aria-label="Loading settings" aria-busy="true">
            <div className="set-col">
              <div className="set-pick" aria-hidden="true">
                <Skel h={36} r={10} />
              </div>
              <div className="set-pane">
                <div className="set-group">
                  <div className="card-hd" aria-hidden="true">
                    <div className="ctitle">
                      <Skel w={32} h={32} r={8} />
                      <span className="ctitle-text set-skel-title">
                        <Skel w={120} h={10} />
                        <Skel w={200} />
                      </span>
                    </div>
                  </div>
                  <div className="set-body">
                    <SkelRows rows={5} height={56} template="minmax(0, 1fr) 240px" cols={[{ w: "50%", lines: 2 }, 240]} label="Loading settings" />
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
        <Spacer end />
      </main>
    </>
  );
}
