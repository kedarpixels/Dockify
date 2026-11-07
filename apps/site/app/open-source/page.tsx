import Link from "next/link";
import { Spacer } from "@/components/ui/rule";
import { PageHead } from "@/components/site/page-head";
import { Body, Cell, Grid, Rows, Section, Src } from "@/components/pages/kit";
import { Closer } from "@/components/pages/closer";
import { REPO, repoHref } from "@/lib/site";
import { pageMetadata } from "@/components/seo/metadata";

export const metadata = pageMetadata({
  path: "/open-source",
  title: "Open source",
  description: "Dockify is free and open source under the Apache License 2.0. The whole product lives in one repository, with no paid tier holding features back.",
});

/* The top of the repository. */
const LAYOUT = [
  { key: "api", term: "apps/api", desc: "The control-plane API." },
  { key: "worker", term: "apps/worker", desc: "The job queue worker and the container builder." },
  { key: "agent", term: "apps/agent", desc: "The on-server agent and the gate in front of Docker." },
  { key: "web", term: "apps/web", desc: "The dashboard." },
  { key: "site", term: "apps/site", desc: "This website and the docs." },
  { key: "contracts", term: "packages/contracts", desc: "Schemas and types for every endpoint. The single source of truth." },
  { key: "db", term: "packages/db", desc: "The database schema, migrations and sealed-secret helpers." },
  { key: "crypto", term: "packages/crypto", desc: "Envelope encryption and token hashing." },
  { key: "engine", term: "packages/engine", desc: "The container builder, Docker calls, builds and routes." },
  { key: "email", term: "packages/email", desc: "The transactional email templates and the SMTP sender." },
  { key: "netguard", term: "packages/net-guard", desc: "The one rule outbound calls to user-given addresses are checked against." },
  { key: "notify", term: "packages/notify", desc: "Chat and webhook notifications." },
  { key: "redact", term: "packages/redact", desc: "Secret redaction for build and runtime logs." },
  { key: "installer", term: "installer", desc: "The one-line server installer and uninstaller." },
  { key: "deploy", term: "deploy", desc: "The production Dockerfile and docker-compose.yml." },
  { key: "docs", term: "docs", desc: "The architecture and the release process." },
  { key: "releases", term: "docs/releases", desc: "Release notes, one file per version." },
  { key: "scripts", term: "scripts/release", desc: "Building, signing and checking a release manifest." },
];

const NO = [
  { icon: "grid", title: "A plugin system", body: "Every feature is in the product, reviewed like the rest of it." },
  { icon: "layers", title: "A huge template catalog", body: "Postgres, Redis and any Docker image cover the job." },
] as const;

export default function Page() {
  const license = repoHref("blob/main/LICENSE");
  const issues = repoHref("issues/new");
  return (
    <main id="main" className="page">
      <Spacer />
      <PageHead
        eyebrow="Open source"
        title="Open source"
        lead="Dockify is free and open source under the Apache License 2.0. The whole product lives in one repository, and there is no paid tier holding features back."
      />
      <Spacer />
      <Section id="license" title="License">
        <Body>
          <p className="pg-state">
            <span className="dot" aria-hidden="true" />
            Apache License 2.0
          </p>
          <p>
            Use it, change it, run it for your clients. The LICENSE file at the root of the repository has the full text
            {license ? (
              <>
                {" "}
                (
                <a className="link-inline" href={license} target="_blank" rel="noreferrer noopener">
                  read it on GitHub
                </a>
                )
              </>
            ) : null}
. As with any Apache-2.0 project, the license does not cover using the Dockify name or logo for another product.
          </p>
        </Body>
      </Section>
      <Spacer />
      <Section id="contributing" title="Contributing">
        <Grid cols={3}>
          <Cell icon="edit" title="Small fixes" foot={<Link className="pg-src" href="/docs/contributing">Contributing guide</Link>}>
            <p>Small fixes are welcome as pull requests. Read the contributing guide first: it covers the checks a change has to pass.</p>
          </Cell>
          <Cell icon="info" title="Anything larger" foot={issues ? <Src href={issues} label="Open an issue" /> : undefined}>
            <p>Open an issue first, so we can agree on the shape before you spend the time.</p>
          </Cell>
          <Cell icon="shield" title="Security reports" foot={<Link className="pg-src" href="/security#report">Security page</Link>}>
            <p>Security reports go to the security page, never to a public issue.</p>
          </Cell>
        </Grid>
      </Section>
      <Spacer />
      <Section id="conduct" title="Code of conduct">
        <Body>
          <p>
            There is no code of conduct file in the repository yet. Until there is, the{" "}
            <Link href="/docs/contributing#how-we-work-together" className="link-inline">
              contributing guide
            </Link>{" "}
            sets the expectations for issues, pull requests and reviews: be kind, assume good faith and keep to the point.
          </p>
        </Body>
      </Section>
      <Spacer />
      <Section id="no" title="What we will say no to" lead="Dockify stays small on purpose. Saying this up front saves everyone time.">
        <Grid cols={2}>
          {NO.map((n) => (
            <Cell key={n.title} icon={n.icon} title={n.title}>
              <p>{n.body}</p>
            </Cell>
          ))}
        </Grid>
      </Section>
      <Spacer />
      <Section id="repo" title="What is in the repository">
        <Rows items={LAYOUT} mono />
      </Section>
      <Spacer />
      <Closer
        title="Read the code, run it, change it."
        primary={REPO ? { href: REPO, label: "View on GitHub", icon: "github", external: true } : { href: "/install", label: "Install on your server", icon: "terminal" }}
        secondary={REPO ? { href: "/install", label: "Install" } : { href: "/docs/contributing", label: "Contributing guide" }}
      />
      <Spacer end />
    </main>
  );
}
