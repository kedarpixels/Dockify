import Link from "next/link";
import { Icon } from "@/components/icon";
import { REPO } from "@/lib/site";

/* Native details, so it works without JavaScript. */
const FAQ: { q: string; a: React.ReactNode }[] = [
  { q: "Who is Dockify for?", a: "People who run several projects on one VPS. Need many servers today? Coolify or Dokploy will suit you better." },
  {
    q: "How is it different from Coolify or Dokploy?",
    a: (
      <>
        It does less, on purpose, and spends the effort on safe deploys and tested backups. See the{" "}
        <Link href="/compare" className="link-inline">
          comparison
        </Link>
        .
      </>
    ),
  },
  {
    q: "What happens if a deploy fails?",
    a: "The old version keeps serving and the deploy is marked failed with the reason. Turn on Deploy failed in Settings, Notifications to hear about it by webhook, and by email once email is set up.",
  },
  { q: "Where do my backups go?", a: "To your own S3-compatible bucket, such as R2, B2 or S3, encrypted before they leave the server. Until you add one, they stay on the server's own disk." },
  { q: "What does it cost?", a: "Nothing. Dockify is open source under the Apache License 2.0 and runs on your server; you pay your VPS provider." },
];

export function Faq() {
  return (
    <section className="ld-faq" aria-labelledby="ld-faq-title">
      <div className="ld-faq-side">
        <h2 id="ld-faq-title" className="ld-h2">
          Questions, answered plainly.
        </h2>
        <p className="ld-lead">
          Anything else? Read the{" "}
          <Link href="/docs/faq" className="link-inline">
            docs FAQ
          </Link>
          {REPO ? (
            <>
              {" "}
              or{" "}
              <a href={`${REPO}/issues`} className="link-inline" target="_blank" rel="noreferrer noopener">
                ask on GitHub
              </a>
            </>
          ) : null}
          .
        </p>
      </div>
      <div className="ld-faq-list">
        {FAQ.map((f) => (
          <details key={f.q} className="ld-qa" name="faq">
            <summary>
              <span>{f.q}</span>
              <span className="ld-qa-ic" aria-hidden="true">
                <Icon name="plus" size={14} />
              </span>
            </summary>
            <div className="ld-qa-a">
              <p>{f.a}</p>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
