import { Fragment, type ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";

/** A fenced code block: a ruled head with the language and a copy key, then the code. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const text = code.replace(/\n$/, "");
  return (
    <div className="code">
      <div className="code-hd">
        <span className="code-lang">{lang ?? "text"}</span>
        <CopyButton value={text} what="code" align="end" />
      </div>
      <pre className="code-body">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** A URL may break after each slash of its path, never inside a name, when a narrow line needs it. */
function breakableUrl(word: string, key: number): ReactNode {
  const m = /^(https?:\/\/)(.+)$/.exec(word);
  if (!m?.[1] || !m[2]) return word;
  const parts = m[2].split("/");
  return (
    <Fragment key={key}>
      {m[1]}
      {parts.map((p, i) =>
        i < parts.length - 1 ? (
          <Fragment key={i}>
            {p}/<wbr />
          </Fragment>
        ) : (
          p
        ),
      )}
    </Fragment>
  );
}

/**
 * The command's words. A flag never breaks at its own hyphens, and a pipe stays on one line with the
 * word after it, so a wrapped command never leaves "sh" or "dry-run" alone on a line. The spaces
 * stay plain spaces and a break opportunity adds no character, so a selection copies as typed.
 */
function commandWords(command: string): ReactNode[] {
  const words = command.split(" ");
  const out: ReactNode[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const next = words[i + 1];
    if (i > 0) out.push(" ");
    if (word === "|" && next !== undefined) {
      out.push(
        <span key={i} className="cmdline-nw">
          | {next}
        </span>,
      );
      i++;
    } else if (word.startsWith("-")) {
      out.push(
        <span key={i} className="cmdline-nw">
          {word}
        </span>,
      );
    } else out.push(breakableUrl(word, i));
  }
  return out;
}

/** A single copyable command line, for the hero and the install page. `what` names it for screen readers. */
export function CommandLine({ command, what = "install command" }: { command: string; what?: string }) {
  return (
    <div className="cmdline">
      <span className="cmdline-prompt" aria-hidden="true">
        $
      </span>
      <code className="cmdline-text">{commandWords(command)}</code>
      <CopyButton value={command} what={what} align="end" />
    </div>
  );
}
