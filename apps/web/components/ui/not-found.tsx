/**
 * The one not-found block: the pixel code (the page's one display mark), the title as the page's
 * h1, one line and the ways back. Render it as a block of `main.page`.
 *
 * `frame="console"` (the signed-in 404) centres it in the page and offers the command menu;
 * `frame="public"` (a status page anyone can open) sits between the bands with a smaller code and
 * nothing that needs a session.
 *
 *   <NotFound actions={<Link href="/" className="btn btn-primary">Back to overview</Link>} />
 *   <NotFound frame="public" title="No status page here" body="This project has not published a status page, or the link is wrong." />
 */
export function NotFound({
  title = "This page does not exist",
  body = "It may have moved. Everything else is where you left it.",
  code = "404",
  frame = "console",
  actions,
}: {
  title?: string;
  body?: React.ReactNode;
  code?: string;
  frame?: "console" | "public";
  /** The ways back: a primary key home, and at most one more. */
  actions?: React.ReactNode;
}) {
  return (
    <section className="notfound" data-frame={frame} aria-labelledby="notfound-title">
      <p className="notfound-code pixel" aria-hidden="true">
        {code}
      </p>
      <h1 id="notfound-title" className="notfound-title">
        {title}
      </h1>
      <p className="notfound-text">{body}</p>
      {actions ? <div className="notfound-actions">{actions}</div> : null}
      {frame === "console" ? (
        <p className="notfound-hint">
          Or press
          <kbd className="kbd">Ctrl</kbd>
          <kbd className="kbd">K</kbd>
          to search
        </p>
      ) : null}
    </section>
  );
}
