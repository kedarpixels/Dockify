import Link from "next/link";
import { Node } from "@/components/ui/rule";
import { repoHref } from "@/lib/site";
import { Cell, Grid, Section, Src, TONE_WORD, ToneDot, type Tone } from "./kit";

/* Every competitor cell links where it was read; all were checked against their sources on 6 November 2026. */

type CmpCell = { tone: Tone; text: string; src?: { href: string; label?: string }[]; docs?: string };
type Row = { feature: string; note?: string; dockify: CmpCell; coolify: CmpCell; dokploy: CmpCell; vercel: CmpCell };

const COLS = [
  { key: "dockify", name: "Dockify" },
  { key: "coolify", name: "Coolify" },
  { key: "dokploy", name: "Dokploy" },
  { key: "vercel", name: "Vercel" },
] as const;

const ROWS: Row[] = [
  {
    feature: "Zero downtime with automatic rollback",
    dockify: { tone: "yes", text: "Stateless apps, gated on a health check. A failed check keeps the old version serving.", docs: "/docs/rollback" },
    coolify: {
      tone: "part",
      text: "Rolling updates keep the old container when the new one fails its health check. Not for Compose, host ports, custom names or previews.",
      src: [{ href: "https://coolify.io/docs/applications/deployments/rolling-updates" }],
    },
    dokploy: {
      tone: "part",
      text: "Needs Swarm health checks set by hand. Rollback through Swarm config.",
      src: [
        { href: "https://docs.dokploy.com/docs/core/applications/zero-downtime", label: "Zero downtime" },
        { href: "https://docs.dokploy.com/docs/core/applications/rollbacks", label: "Rollbacks" },
      ],
    },
    vercel: { tone: "yes", text: "Yes. Traffic moves only when the new build is ready.", src: [{ href: "https://vercel.com/docs/deployments" }] },
  },
  {
    feature: "Instant rollback",
    note: "No rebuild",
    dockify: { tone: "yes", text: "Yes, by image id, with no rebuild.", docs: "/docs/rollback" },
    coolify: { tone: "yes", text: "Listed as instant rollback.", src: [{ href: "https://coolify.io" }] },
    dokploy: { tone: "yes", text: "Yes.", src: [{ href: "https://docs.dokploy.com/docs/core/applications/rollbacks" }] },
    vercel: { tone: "yes", text: "Yes.", src: [{ href: "https://vercel.com/docs/instant-rollback" }] },
  },
  {
    feature: "Tested encrypted backups",
    note: "Proven by a real restore",
    dockify: {
      tone: "yes",
      text: "Encrypted on the server and sent to your bucket. Postgres backups are then restored into a throwaway database on a schedule.",
      docs: "/docs/backups",
    },
    coolify: {
      tone: "part",
      text: "Scheduled backups. Restore from the dashboard has been an open request since 2024.",
      src: [{ href: "https://github.com/coollabsio/coolify/issues/2389", label: "#2389" }],
    },
    dokploy: {
      tone: "part",
      text: "Scheduled backups with restore from the dashboard. No scheduled restore test.",
      src: [
        { href: "https://docs.dokploy.com/docs/core/databases/backups", label: "Backups" },
        { href: "https://docs.dokploy.com/docs/core/databases/restore", label: "Restore" },
      ],
    },
    vercel: { tone: "no", text: "No: databases come from Marketplace providers.", src: [{ href: "https://vercel.com/marketplace" }] },
  },
  {
    feature: "Per-app alerts",
    dockify: { tone: "yes", text: "Rules per app for down, crash loops and memory, plus host disk.", docs: "/docs/alerts" },
    coolify: {
      tone: "part",
      text: "Notifications when a resource stops, restarts or hits its restart limit, plus deploys and disk. No memory rules.",
      src: [{ href: "https://coolify.io/docs/core/notifications/events" }],
    },
    dokploy: { tone: "part", text: "Server CPU and memory only.", src: [{ href: "https://docs.dokploy.com/docs/core/monitoring" }] },
    vercel: { tone: "part", text: "Anomaly alerts on Pro and Enterprise with Observability Plus.", src: [{ href: "https://vercel.com/docs/alerts" }] },
  },
  {
    feature: "Multi-server",
    dockify: { tone: "soon", text: "Not yet. Today one Dockify runs one server; more servers are planned." },
    coolify: { tone: "yes", text: "Yes.", src: [{ href: "https://coolify.io/docs" }] },
    dokploy: { tone: "yes", text: "Yes, remote servers and Swarm.", src: [{ href: "https://docs.dokploy.com/docs/core" }] },
    vercel: { tone: "no", text: "No, not on your servers: Vercel runs it across its own regions.", src: [{ href: "https://vercel.com/docs/regions" }] },
  },
  {
    feature: "Templates",
    dockify: { tone: "part", text: "6 reviewed apps that ship with the release, plus any Docker image. No large catalog.", docs: "/docs/templates" },
    coolify: { tone: "yes", text: "360+ one-click services.", src: [{ href: "https://coolify.io" }] },
    dokploy: { tone: "yes", text: "Templates included.", src: [{ href: "https://dokploy.com" }] },
    vercel: { tone: "yes", text: "Framework templates and a Marketplace.", src: [{ href: "https://vercel.com/templates" }] },
  },
  {
    feature: "Preview deploys",
    note: "Per pull request",
    dockify: {
      tone: "yes",
      text: "Per pull request, with caps, sleep when idle and cleanup checked every few minutes.",
      docs: "/docs/previews",
    },
    coolify: {
      tone: "yes",
      text: "Yes, removed when the pull request closes or merges.",
      src: [{ href: "https://coolify.io/docs/applications/ci-cd/github/preview-deploy" }],
    },
    dokploy: { tone: "part", text: "Yes, but not for Compose.", src: [{ href: "https://github.com/Dokploy/dokploy/issues/2028", label: "#2028" }] },
    vercel: { tone: "yes", text: "Yes.", src: [{ href: "https://vercel.com/docs/deployments/environments#preview-environment-pre-production" }] },
  },
  {
    feature: "Open-source license",
    dockify: { tone: "yes", text: "Apache-2.0.", docs: "/open-source#license" },
    coolify: { tone: "yes", text: "Apache-2.0.", src: [{ href: "https://github.com/coollabsio/coolify/blob/main/LICENSE" }] },
    dokploy: {
      tone: "part",
      text: "Open core. Paid parts are source-available.",
      src: [{ href: "https://dokploy.com/blog/we-are-updating-dokploys-open-source-license" }],
    },
    vercel: { tone: "no", text: "Proprietary.", src: [{ href: "https://vercel.com/legal/terms" }] },
  },
  {
    feature: "Price",
    dockify: { tone: "yes", text: "Free. You pay your VPS provider." },
    coolify: { tone: "yes", text: "Free to self-host, or a paid cloud.", src: [{ href: "https://coolify.io" }] },
    dokploy: { tone: "yes", text: "Free to self-host, or a paid cloud and enterprise tier.", src: [{ href: "https://dokploy.com" }] },
    vercel: { tone: "part", text: "Usage-based.", src: [{ href: "https://vercel.com/pricing" }] },
  },
];

/* The key lists only the marks the table uses, in a fixed order. */
const LEGEND = (["yes", "part", "no", "soon"] as const).filter((t) => ROWS.some((r) => COLS.some((c) => r[c.key].tone === t)));
const LEGEND_WORD: Partial<Record<Tone, string>> = { part: "Partly, or with limits", soon: "Not available yet" };

function CellBody({ c }: { c: CmpCell }) {
  return (
    <>
      <span className="cmp-val">
        <ToneDot tone={c.tone} />
        <span>{c.text}</span>
      </span>
      {c.src?.length ? (
        <span className="cmp-src">
          {c.src.map((s) => (
            <Src key={s.href} href={s.href} label={s.label} />
          ))}
        </span>
      ) : c.docs ? (
        <span className="cmp-src">
          <Link className="pg-src" href={c.docs}>
            How it works
          </Link>
        </span>
      ) : null}
    </>
  );
}

/** Below 1001px each row becomes a ruled block with the product named on every line. */
export function CompareTable() {
  const issue = repoHref("issues/new");
  const last = ROWS.length - 1;
  return (
    <section className="cmp" aria-labelledby="cmp-h">
      <h2 id="cmp-h" className="sr">
        Feature comparison
      </h2>
      <div className="cmp-legend" aria-hidden="true">
        {LEGEND.map((t) => (
          <span key={t} className="cmp-key">
            <ToneDot tone={t} alone />
            {t === "soon" ? LEGEND_WORD.soon : (LEGEND_WORD[t] ?? TONE_WORD[t])}
          </span>
        ))}
      </div>
      <table className="cmp-table">
        <thead>
          <tr>
            <th scope="col" className="cmp-feat">
              <Node pos="tl" />
              <span className="sr">Feature</span>
            </th>
            {COLS.map((c, i) => (
              <th key={c.key} scope="col">
                <Node pos="tl" />
                {i === COLS.length - 1 ? <Node pos="tr" /> : null}
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r, ri) => (
            <tr key={r.feature}>
              <th scope="row" className="cmp-feat">
                <Node pos="tl" />
                {ri === last ? <Node pos="bl" /> : null}
                <span className="cmp-feat-h">{r.feature}</span>
                {r.note ? <span className="cmp-feat-sub">{r.note}</span> : null}
              </th>
              {COLS.map((c, ci) => (
                <td key={c.key} data-label={c.name}>
                  <Node pos="tl" />
                  {ci === COLS.length - 1 ? <Node pos="tr" /> : null}
                  {ri === last ? <Node pos="bl" /> : null}
                  {ri === last && ci === COLS.length - 1 ? <Node pos="br" /> : null}
                  <CellBody c={r[c.key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cmp-note">
        Checked against every source on 6 November 2026.
        {issue ? (
          <>
            {" "}
            If a row is wrong,{" "}
            <a className="link-inline" href={issue} target="_blank" rel="noreferrer noopener">
              open an issue
            </a>{" "}
            and we will fix it.
          </>
        ) : null}
      </p>
    </section>
  );
}

const SWITCH = [
  {
    from: "Coolify",
    icon: "server",
    why: [
      "Backups restored on a schedule, so you know they work.",
      "First login over HTTPS, with no dashboard port open to the internet.",
      "Alert rules for memory per app, not only stops and restarts.",
    ],
    stay: "Stay on Coolify if you need many servers today, or a large template catalog.",
  },
  {
    from: "Dokploy",
    icon: "layers",
    why: [
      "Zero downtime without writing Swarm health checks by hand.",
      "Alerts that name the app, not only the server.",
      "One free product, with no paid tier holding features back.",
    ],
    stay: "Stay on Dokploy if you want Docker Swarm or enterprise SSO.",
  },
  {
    from: "Vercel",
    icon: "vercel",
    why: [
      "One flat server bill instead of usage pricing.",
      "Variables and data stay on a server you control.",
      "Import a Vercel project's variables and domains, then point the domain.",
    ],
    stay: "Stay on Vercel if you want a global edge network and you are fine paying by usage.",
  },
] as const;

export function WhySwitch() {
  return (
    <Section
      id="why-switch"
      title="Why switch"
      lead="Dockify does less than the others, on purpose. Here is what you get for it, and when you should not move."
    >
      <Grid cols={3}>
        {SWITCH.map((s) => (
          <Cell key={s.from} icon={s.icon} title={`From ${s.from}`} foot={<p className="pg-stay">{s.stay}</p>}>
            <ul className="pg-ticks">
              {s.why.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Cell>
        ))}
      </Grid>
    </Section>
  );
}
