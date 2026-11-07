import { Node } from "@/components/ui/rule";
import { formatDay, type Release } from "@/lib/releases";

/**
 * One release: a meta column (version, date, state, signed release) beside the notes. The column
 * divider meets the rule above and the Spacer below, so it carries a node at each end.
 */
export function Entry({ r }: { r: Release }) {
  const released = r.date !== null;
  return (
    <article className="cl" id={`v${r.version}`} aria-labelledby={`v${r.version}-h`}>
      <div className="cl-meta">
        <Node pos="tl" />
        <h2 id={`v${r.version}-h`} className="cl-ver pixel">
          {r.version}
        </h2>
        <p className="cl-state" data-released={released || undefined}>
          <span className="dot" aria-hidden="true" />
          {r.date ? <time dateTime={r.date}>{formatDay(r.date)}</time> : "Not released yet"}
        </p>
        <p className="cl-signed">
          {r.signed ? (
            <a className="link-inline" href={r.signed}>
              Signed release
            </a>
          ) : released ? (
            "Signed release on GitHub."
          ) : (
            "The signed release is linked here when it ships."
          )}
        </p>
      </div>
      <div className="cl-notes">
        <Node pos="tl" />
        <Node pos="tr" />
        <Node pos="bl" />
        <p className="cl-sum">{r.summary}</p>
        {r.groups.map((g) => (
          <section key={g.title} className="cl-group" aria-label={g.title}>
            <h3 className="cl-group-h">{g.title}</h3>
            <ul className="pg-ticks">
              {g.items.map((it) => (
                <li key={it}>{it}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
