import Link from "next/link";
import type { ReactNode } from "react";
import { CommandLine } from "@/components/docs/code-block";
import { Icon, type IconName } from "@/components/icon";
import { AlertDemo } from "@/components/landing/alert-demo";
import { BackupDemo } from "@/components/landing/backup-demo";
import { DeployDemo } from "@/components/landing/deploy-demo";
import { DiskDemo } from "@/components/landing/disk-demo";
import { DitherCloud } from "@/components/landing/dither-cloud";
import { Faq } from "@/components/landing/faq";
import { HeroScene } from "@/components/landing/hero-scene";
import { ProductShot } from "@/components/landing/product-shot";
import { RollbackDemo } from "@/components/landing/rollback-demo";
import { Steps } from "@/components/landing/steps";
import { ToneDot, TONE_WORD, type Tone } from "@/components/pages/kit";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/components/seo/config";
import { pageMetadata } from "@/components/seo/metadata";
import { Corners, Rule, Spacer } from "@/components/ui/rule";
import { INSTALL_CMD } from "@/lib/site";

/* Landing. One idea per section: the hero, the tools it works with, the real dashboard, five
   differentiators, three steps, a short comparison, the FAQ and the call to install. */

export const metadata = pageMetadata({ path: "/", absolute: SITE_TITLE, description: SITE_DESCRIPTION });

const BIG = {
  title: "Zero downtime, with automatic rollback",
  line: "A new version of a stateless app gets traffic only after it passes its health check. If it fails, the old one keeps serving.",
};

const MEDIUM: { title: string; line: string; demo: ReactNode }[] = [
  { title: "Backups, tested for real", line: "Encrypted and sent to your bucket. Postgres backups are restored into a throwaway database each week.", demo: <BackupDemo /> },
  { title: "Instant rollback", line: "The last five good deploys are kept by image. No rebuild.", demo: <RollbackDemo /> },
  { title: "A disk that stays clean", line: "Old images and build cache cleaned on a schedule. Rollback images stay.", demo: <DiskDemo /> },
  { title: "Alerts that name the app", line: "Rules per app, sent to the dashboard, Discord, email or a webhook.", demo: <AlertDemo /> },
];

const WORKS: { icon: IconName; name: string }[] = [
  { icon: "github", name: "GitHub" },
  { icon: "box", name: "Docker" },
  { icon: "cloud", name: "Cloudflare" },
  { icon: "vercel", name: "Vercel" },
  { icon: "database", name: "Postgres" },
  { icon: "layers", name: "Redis" },
  { icon: "archive", name: "S3" },
  { icon: "archive", name: "R2" },
];

/* Every competitor mark follows a cell on /compare, where each one links its source. Checked on
   6 November 2026. A hosted platform gets "does not apply" where the row is about your own servers. */
const CMP_COLS = ["Dockify", "Coolify", "Dokploy", "Vercel"];
const CMP: { row: string; marks: [Tone, Tone, Tone, Tone] }[] = [
  { row: "Zero-downtime deploys for stateless apps", marks: ["yes", "part", "part", "yes"] },
  { row: "Automatic rollback on a failed check", marks: ["yes", "part", "part", "part"] },
  { row: "Backups tested by a real restore", marks: ["yes", "no", "no", "no"] },
  { row: "HTTPS dashboard from the first login", marks: ["yes", "no", "no", "yes"] },
  { row: "Preview deploys per pull request", marks: ["yes", "yes", "part", "yes"] },
  { row: "Runs across many of your servers", marks: ["soon", "yes", "yes", "no"] },
];
const KEY: Tone[] = ["yes", "part", "no", "soon"];

export default function Home() {
  return (
    <main id="main" className="page ld">
      <Spacer />

      {/* -------------- Hero -------------- */}
      <section className="ld-hero">
        <div className="ld-hero-copy">
          <p className="ld-eyebrow">
            <Link href="/open-source" className="ld-chip">
              <Icon name="sparkles" size={14} />
              Open source and self-hosted
            </Link>
          </p>
          <h1 className="ld-h1 ld-h1-xl">
            <span>Every project.</span>
            <span>One server.</span>
          </h1>
          <p className="ld-hero-lead">
            Deploy from GitHub. Dockify handles domains, databases, backups and rollbacks. <b>Then you sleep.</b>
          </p>
          <div className="ld-ctas">
            <Link href="/install" className="btn btn-primary ld-btn-lg">
              <Icon name="terminal" size={16} />
              Install on your server
            </Link>
            <Link href="/docs" className="btn ld-btn-lg">
              Read the docs
            </Link>
          </div>
          <div className="ld-hero-cmd">
            <CommandLine command={INSTALL_CMD} />
          </div>
        </div>
        <div className="ld-hero-art">
          <HeroScene />
        </div>
      </section>

      <section className="ld-works" aria-label="Works with">
        <ul className="ld-works-list">
          {WORKS.map((w) => (
            <li key={w.name}>
              <Icon name={w.icon} size={16} />
              {w.name}
            </li>
          ))}
        </ul>
      </section>

      <Spacer />
      <ProductShot />

      {/* -------------- Differentiators -------------- */}
      <Spacer />
      <section className="ld-sec-hd" aria-labelledby="ld-diff-title">
        <h2 id="ld-diff-title" className="ld-h2 ld-h2-lg">
          Deploys that keep your apps up. Backups restored for real, on a schedule.
        </h2>
      </section>
      <section className="ld-bento" aria-label="What Dockify does differently">
        <article className="ld-bcell ld-bcell-lg">
          <Corners />
          <DeployDemo />
          <div className="ld-btext">
            <h3 className="ld-h3">{BIG.title}</h3>
            <p>{BIG.line}</p>
          </div>
        </article>
        {MEDIUM.map((m) => (
          <article key={m.title} className="ld-bcell">
            <Corners />
            {m.demo}
            <div className="ld-btext">
              <h3 className="ld-h3">{m.title}</h3>
              <p>{m.line}</p>
            </div>
          </article>
        ))}
      </section>

      {/* -------------- How it works -------------- */}
      <Spacer />
      <section className="ld-sec-hd" aria-labelledby="ld-how-title">
        <h2 id="ld-how-title" className="ld-h2">
          Three steps to your first deploy.
        </h2>
      </section>
      <Steps />

      {/* -------------- Compare -------------- */}
      <Spacer />
      <section className="ld-sec-hd ld-sec-hd-row" aria-labelledby="ld-cmp-title">
        <div>
          <h2 id="ld-cmp-title" className="ld-h2">
            Less, on purpose.
          </h2>
          <p className="ld-lead">Where the others do more, we say so.</p>
        </div>
        <Link href="/compare" className="btn">
          See the full comparison
        </Link>
      </section>
      <div className="ld-cmp-wrap">
        <table className="ld-cmp">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr">Feature</span>
              </th>
              {CMP_COLS.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CMP.map((r) => (
              <tr key={r.row}>
                <th scope="row">{r.row}</th>
                {r.marks.map((m, i) => (
                  <td key={CMP_COLS[i]}>
                    <ToneDot tone={m} alone />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Rule />
      <div className="ld-cmp-foot">
        <ul className="ld-cmp-key" aria-label="Key">
          {KEY.map((m) => (
            <li key={m}>
              <ToneDot tone={m} alone />
              <span aria-hidden="true">{m === "soon" ? "Not available yet" : TONE_WORD[m]}</span>
            </li>
          ))}
        </ul>
        <p className="ld-cmp-date">
          Checked on 6 November 2026. Every source is on the{" "}
          <Link href="/compare" className="link-inline">
            comparison page
          </Link>
          .
        </p>
      </div>

      {/* -------------- FAQ -------------- */}
      <Spacer />
      <Faq />

      {/* -------------- Final call -------------- */}
      <Spacer />
      <section className="ld-final" aria-labelledby="ld-final-title">
        <DitherCloud corner="bottom-left" cols={56} rows={30} seed={8} className="ld-final-cloud ld-final-bl" />
        <DitherCloud corner="top-right" cols={64} rows={34} seed={3} className="ld-final-cloud ld-final-tr" />
        <h2 id="ld-final-title" className="ld-h1">
          Your server is waiting.
        </h2>
        <div className="ld-ctas ld-ctas-center">
          <Link href="/install" className="btn btn-primary ld-btn-lg">
            <Icon name="terminal" size={16} />
            Install Dockify
          </Link>
          <Link href="/docs" className="btn ld-btn-lg">
            Read the docs
          </Link>
        </div>
      </section>
      <Spacer end />
    </main>
  );
}
