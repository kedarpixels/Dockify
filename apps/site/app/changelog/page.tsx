import { Spacer } from "@/components/ui/rule";
import { PageHead } from "@/components/site/page-head";
import { CodeBlock } from "@/components/docs/code-block";
import { Body, Section } from "@/components/pages/kit";
import { Entry } from "@/components/pages/changelog";
import { loadReleases } from "@/lib/releases";
import { pageMetadata } from "@/components/seo/metadata";

export const metadata = pageMetadata({ path: "/changelog", title: "Changelog", description: "Versioned releases, newest first. Each entry links its signed release." });

/* Entries come from the release notes, the same files the signed release feed is built from. An unreleased
   version stays marked so, with no date and no release link. */

const FORMAT = `## 1.1.0 (YYYY-MM-DD)

One line that says what this release is for.

### Added
- New things you can do.

### Changed
- Things that work differently. Say what to do if it affects you.

### Fixed
- Bugs, named by what you saw, not by the code.

### Security
- Fixes with a CVE or advisory link, and who reported it if they agree.`;

export default async function Page() {
  const releases = await loadReleases();
  const shipped = releases.some((r) => r.date !== null);
  const lead = shipped
    ? "Versioned releases, newest first. Each entry links its signed release."
    : releases.length > 0
      ? "Versioned releases, newest first. Each entry links its signed release. Nothing has shipped yet, so the first entry is still open."
      : "Versioned releases, newest first. Each entry links its signed release. Nothing has shipped yet.";
  return (
    <main id="main" className="page">
      <Spacer />
      <PageHead
        eyebrow="Changelog"
        title="Changelog"
        lead={lead}
      />
      {releases.map((r) => (
        <Entry key={r.version} r={r} />
      ))}
      <Spacer />
      <Section
        id="format"
        title="How entries are written"
        lead="Every release is one file, docs/releases/<version>.md in the repository: the version and date (or unreleased), one line, then Added, Changed, Fixed and Security. Empty groups are left out. The same notes ship in the signed release feed."
      >
        <Body>
          <CodeBlock code={FORMAT} lang="md" />
        </Body>
      </Section>
      <Spacer end />
    </main>
  );
}
