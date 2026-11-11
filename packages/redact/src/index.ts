/**
 * Redacts deploy and runtime logs: exact secret values first, then patterns for credentials that
 * name themselves. Best effort: a secret split across lines or encoded differently gets through.
 */
export const MARK = "[REDACTED]";

/** Below this a value is too short to search for without blanking ordinary text ("true", "8080"). */
export const MIN_SECRET_LENGTH = 6;
const MAX_PEM_LINES = 100;

// Every pattern must run in linear time: one hostile line must not wedge the single worker event loop.
// Matches start only at a fixed anchor, so a secret needs no length cap and is hidden whole.
const KEYWORDS = /password|passwd|secret|token|api_?key|private_?key|credential|authorization|cookie|dsn|connection_?string/i;
const PATTERNS: Array<[RegExp, string, ((s: string) => boolean)?]> = [
  // user:password@ in a URL. The lookbehind checks the scheme, so letters are not retried as one at each position.
  [/:\/\/(?<=[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/g, `://${MARK}@`, (s) => s.includes("://")],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARK}`],
  [/\b(?:A3T[A-Z0-9]|ABIA|ACCA|AGPA|AIDA|AIPA|AKIA|ANPA|ANVA|APKA|AROA|ASIA)[A-Z0-9]{12,20}\b/g, MARK],
  [/\b(aws_secret_access_key|aws_session_token)\s*[=:]\s*\S+/gi, `$1=${MARK}`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, MARK],
  // A SQL statement quoted in an error: Postgres's CONTEXT line for ALTER ROLE ... PASSWORD '...'.
  [/\bPASSWORD\s+'[^']*'/gi, `PASSWORD '${MARK}'`],
  // key=value and key: value where the key names a secret. A key without a keyword consumes nothing, so
  // the value after it is still tried as a key ("options: password=x"). A path before a colon is not a key.
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
