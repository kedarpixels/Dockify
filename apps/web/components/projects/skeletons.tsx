import { Skel, SkelRows } from "@/components/ui/skeleton";

/*
 * Loading shapes for the project card pages (the routes' loading.tsx): bars at the loaded parts'
 * real sizes, never placeholder words, so nothing jumps when the data lands.
 */

/** One project or app card as bars: the head, the last deployment, the foot. */
export function CardBars({ apps = false }: { apps?: boolean }) {
  return (
    <div className="pj-cell" aria-hidden="true">
      <div className="pj-body">
        <div className="pj-hd">
          <span className="pj-hd-link">
            <Skel w={40} h={40} r={10} />
            <span className="two">
              <Skel w={88} h={10} />
              <Skel w={72} />
            </span>
          </span>
          <Skel w={72} h={28} r={8} />
        </div>
        <div className="pj-sec">
          <Skel w={96} />
          <Skel w="80%" h={10} />
          <Skel w="56%" />
        </div>
        {apps ? (
          <div className="pj-sec">
            <Skel w={40} />
            <SkelRows rows={4} height={36} template="20px minmax(0, 1fr) 64px" cols={[16, "50%", 48]} label="Loading apps" />
          </div>
        ) : null}
      </div>
      <div className="pj-ft">
        <Skel w={64} h={16} r={2} />
        <Skel w={80} />
      </div>
    </div>
  );
}

/** A detail page's head lead and section strip, as bars. */
export function DetailHeadBars() {
  return (
    <span className="pd-lead" aria-hidden="true">
      <Skel w={88} h={28} r={8} />
      <Skel w={96} />
      <Skel w={120} />
    </span>
  );
}

/** The section strip of a detail page, as one bar the width of its tabs. */
export function TabStripBars({ width }: { width: number }) {
  return (
    <div className="tabs-wrap" aria-hidden="true">
      <div className="tabs">
        <Skel w={width} h={36} r={10} />
      </div>
    </div>
  );
}
