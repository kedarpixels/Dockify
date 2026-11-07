/**
 * The one redaction module for deploy logs and runtime logs alike.
 *
 * The literal pass hides the exact secret values a build or a container was given; the pattern
 * pass is the backstop for credentials that name themselves (connection strings, bearer headers,
 * AWS and GitHub key shapes, KEY=value lines, PEM bodies). Best effort by design, and the UI says
 * so: a secret split across lines or encoded differently can get through.
 */
export const MARK = "[REDACTED]";

/** Below this a value is too short to search for without blanking ordinary text ("true", "8080"). */
export const MIN_SECRET_LENGTH = 6;
const MAX_PEM_LINES = 100;

// Every pattern runs in time linear in the line, because one hostile line must not wedge the
// single worker event loop. A match can only start at a fixed anchor (a word boundary, a "://", or
// the first character of a run of key characters), so a long run is never rescanned from each of
// its positions. That is also why the secret itself needs no length cap: a long password, token or
// value is hidden whole instead of leaving its tail in the log. A pattern with a guard is skipped
// on lines the guard rules out.
const KEYWORDS = /password|passwd|secret|token|api_?key|private_?key|credential|authorization|cookie|dsn|connection_?string/i;
const PATTERNS: Array<[RegExp, string, ((s: string) => boolean)?]> = [
  // user:password@ in a URL. The match starts at "://" and a lookbehind checks the scheme before
  // it, so a long run of letters is not tried as a scheme at every position.
  [/:\/\/(?<=[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/g, `://${MARK}@`, (s) => s.includes("://")],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARK}`],
  [/\b(?:A3T[A-Z0-9]|ABIA|ACCA|AGPA|AIDA|AIPA|AKIA|ANPA|ANVA|APKA|AROA|ASIA)[A-Z0-9]{12,20}\b/g, MARK],
  [/\b(aws_secret_access_key|aws_session_token)\s*[=:]\s*\S+/gi, `$1=${MARK}`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, MARK],
  // A SQL statement quoted in an error: Postgres's CONTEXT line for ALTER ROLE ... PASSWORD '...'.
  [/\bPASSWORD\s+'[^']*'/gi, `PASSWORD '${MARK}'`],
  // key=value and key: value where the key names a secret. The key is a whole run of key
  // characters: the lookbehind starts it only where a run starts, and the lookahead checks the run
  // for a keyword without consuming it. A key with no keyword consumes nothing, so the value after
  // it is still checked as a key in turn ("options: password=x"). The end of a path before a colon
  // is not a key: "ls: /run/secrets: No such file" names a folder and holds no value.
  [
    /(?<![A-Za-z0-9_.-])(?!(?<=\/)[A-Za-z0-9_.-]+\s*:)(?=[A-Za-z0-9_.-]*?(?:password|passwd|secret|token|api_?key|private_?key|credential|authorization|cookie|dsn|connection_?string))([A-Za-z0-9_.-]+)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    `$1=${MARK}`,
    (s) => KEYWORDS.test(s),
  ],
];
const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const PEM_END = /-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

export class Redactor {
  private literals: string[] = [];
  private pemLines = 0;

  /** Adds exact values to hide. Short values are skipped; longest values are replaced first. */
  conceal(values: Iterable<string>): this {
    for (const raw of values) {
      const v = raw.trim();
      if (v.length >= MIN_SECRET_LENGTH && !this.literals.includes(v)) this.literals.push(v);
    }
    this.literals.sort((a, b) => b.length - a.length);
    return this;
  }

  line(text: string): string {
    if (this.pemLines > 0) {
      this.pemLines = PEM_END.test(text) ? 0 : this.pemLines - 1;
      return MARK;
    }
    if (PEM_BEGIN.test(text)) {
      this.pemLines = PEM_END.test(text) ? 0 : MAX_PEM_LINES;
      return MARK;
    }
    let out = text;
    for (const lit of this.literals) out = out.split(lit).join(MARK);
    for (const [re, rep, guard] of PATTERNS) {
      if (guard && !guard(out)) continue;
      out = out.replace(re, rep);
    }
    return out;
  }
}
