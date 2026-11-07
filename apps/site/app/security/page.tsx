import { Spacer } from "@/components/ui/rule";
import { PageHead } from "@/components/site/page-head";
import { CodeBlock } from "@/components/docs/code-block";
import { Body, Cell, Grid, Rows, Section, Steps } from "@/components/pages/kit";
import { Closer } from "@/components/pages/closer";
import { REPO } from "@/lib/site";
import { pageMetadata } from "@/components/seo/metadata";

export const metadata = pageMetadata({
  path: "/security",
  title: "Security",
  description:
    "Dockify runs as root-equivalent on your server, so we treat its own code as the biggest risk. Here is how it is built and how to tell us when we got it wrong.",
});

/* Reports go through GitHub private vulnerability reporting on the repository (REPO in lib/site.ts).
   Without a repository, the section says how reporting will open. */

const BUILT = [
  { icon: "terminal", title: "No shell from your input", body: "No shell commands are built from your input. Containers are created through one checked builder." },
  { icon: "list", title: "A policy on every route", body: "Every API route has a declared policy. A test fails if one is missing." },
  {
    icon: "box",
    title: "Locked-down containers",
    body: "Your containers run with capabilities dropped, no privileged mode, no host network and no host folders.",
  },
  { icon: "database", title: "Private databases", body: "Databases are never published on a host port." },
  {
    icon: "key",
    title: "Sealed secrets",
    body: "Each secret is encrypted on its own. Changing an app's settings or variables, or stopping, restarting or deleting it, asks you to confirm it is you again: your authenticator code when two-factor is on, otherwise your password.",
  },
  {
    icon: "lock",
    title: "No inbound ports for Dockify",
    body: "In tunnel mode Dockify opens no inbound port; only SSH stays open. Releases are signed and checked before install.",
  },
] as const;

const PROCESS = [
  { title: "You report it privately.", body: "Through GitHub private vulnerability reporting. Please do not open a public issue." },
  { title: "We reply within 3 working days.", body: "We confirm what we can reproduce and ask what we need." },
  { title: "We agree a fix date with you.", body: "You know when the fix ships before anyone else does." },
  { title: "We credit you in the release notes, if you want.", body: "We ask for 90 days before public disclosure, or less once a fix ships." },
];

const VERSIONS = [
  { key: "latest", term: "Latest minor release", desc: "Gets security fixes." },
  { key: "older", term: "Older releases", desc: "No fixes. Update to the latest minor release first." },
  { key: "pre", term: "Before 1.0", desc: "Not supported. No release has shipped yet." },
];

const SIGNING = [
  { title: "Each release is a manifest signed with minisign.", body: "Ed25519. The signed comment must name the manifest's own version, so a release cannot be relabelled." },
  { title: "The installer checks it against a pinned public key.", body: "Then it pulls the Dockify images by digest, never by a tag that can move." },
  { title: "The updater checks the signature again.", body: "It fetches the feed over HTTPS only, and refuses a feed that resolves to a private address." },
  { title: "It dumps Dockify's own database before it changes anything.", body: "The new images are pulled first, while everything keeps running. Then the api and worker stop briefly for the dump." },
  { title: "If the update fails, it rolls back on its own.", body: "A failed migration, restart or health check restores the dump and the previous images." },
];

/* The raw feed of the repository's releases branch; a placeholder until the repository is set. */
const feed = REPO ? REPO.replace("https://github.com/", "https://raw.githubusercontent.com/") + "/releases" : "https://raw.githubusercontent.com/<owner>/dockify/releases";

const VERIFY = `# Check a release by hand. From 1.0 on, the public key is in deploy/release.pub, installer/install.sh and the GitHub Release.
curl -fsSLO ${feed}/releases/stable.json
curl -fsSLO ${feed}/releases/stable.json.minisig
minisign -Vm stable.json -P <public key>`;

export default function Page() {
  const channels = [
    REPO ? (
      <Cell key="gh" icon="github" title="GitHub private reporting">
        <p>
          On the repository&apos;s Security tab, choose{" "}
          <a className="link-inline" href={`${REPO}/security/advisories/new`} target="_blank" rel="noreferrer noopener">
            Report a vulnerability
          </a>
          . Only the maintainers see it.
        </p>
      </Cell>
    ) : null,
  ].filter(Boolean);

  return (
    <main id="main" className="page">
      <Spacer />
      <PageHead
        eyebrow="Security"
        title="Security"
        lead="Dockify runs as root-equivalent on your server, so we treat its own code as the biggest risk. Here is how it is built and how to tell us when we got it wrong."
      />
      <Spacer />
      <Section id="report" title="Report a vulnerability" lead="Please do not open a public issue.">
        {channels.length ? (
          <Grid cols={channels.length === 2 ? 2 : 1}>{channels}</Grid>
        ) : (
          <Body>
            <p>
              The private channel opens before 1.0 ships: GitHub private vulnerability reporting on the Dockify repository. It will be
              listed here. Until then, please keep a vulnerability out of public places.
            </p>
          </Body>
        )}
      </Section>
      <Spacer />
      <Section id="process" title="What happens next">
        <Steps items={PROCESS} />
      </Section>
      <Spacer />
      <Section id="scope" title="Scope">
        <Body>
          <p>The control plane (api, worker, agent, web), the installer and the release pipeline. Apps you deploy are yours.</p>
        </Body>
      </Section>
      <Spacer />
      <Section id="built" title="How Dockify is built">
        <Grid cols={3}>
          {BUILT.map((b) => (
            <Cell key={b.title} icon={b.icon} title={b.title}>
              <p>{b.body}</p>
            </Cell>
          ))}
        </Grid>
      </Section>
      <Spacer />
      <Section id="versions" title="Supported versions">
        <Rows items={VERSIONS} />
      </Section>
      <Spacer />
      <Section
        id="signing"
        title="How updates are signed"
        lead="From the release feed to your server, every Dockify image is checked before it runs. The first signed release ships with 1.0."
      >
        <Steps items={SIGNING} />
        <Body className="pg-body-ruled">
          <CodeBlock code={VERIFY} lang="bash" />
        </Body>
      </Section>
      <Spacer />
      <Closer
        title="Read the threat model: what is isolated, and what is not."
        primary={{ href: "/docs/security", label: "Read the security docs", icon: "shield" }}
        secondary={{ href: "/open-source", label: "Open source" }}
      />
      <Spacer end />
    </main>
  );
}
