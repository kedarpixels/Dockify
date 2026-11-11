import type { EnvVar } from "@/lib/pages/project-detail";

// Follows the dotenv rules operators expect: `export ` prefixes, # comments, literal single quotes,
// escapes and multi-line values in double quotes, CRLF or CR line ends, and a byte order mark.

/** A variable name, as the API's: a letter or underscore, then letters, digits and underscores, 128 at most. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type EnvDraft = Pick<EnvVar, "key" | "value" | "secret">;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

const unescape = (s: string) => s.replace(/\\([nrt"\\])/g, (_, c: string) => ESCAPES[c]!);

/** Index of the quote that closes a value opened by `q`, skipping escaped quotes in double quotes. */
function closing(s: string, q: string) {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") i += 1;
    else if (s[i] === q) return i;
  }
  return -1;
}

/** Later lines win over earlier ones with the same key. */
export function parseDotenv(text: string): { vars: EnvDraft[]; skipped: number } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const vars = new Map<string, EnvDraft>();
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trimStart();
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq < 0 ? "" : line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!ENV_KEY.test(key)) {
      skipped += 1;
      continue;
    }

    let rest = raw.slice(eq + 1).trimStart();
    const q = rest[0];
    let value: string;
    if (q === '"' || q === "'" || q === "`") {
      rest = rest.slice(1);
      let end = closing(rest, q);
      // An open double or backtick quote carries on over the next lines until it closes.
      while (end < 0 && q !== "'" && i + 1 < lines.length) {
        rest += `\n${lines[++i]}`;
        end = closing(rest, q);
      }
      if (end < 0) {
        skipped += 1;
        continue;
      }
      value = rest.slice(0, end);
      if (q === '"') value = unescape(value);
    } else {
      value = rest.replace(/(^|\s)#.*$/, "").trimEnd();
    }
    vars.delete(key);
    vars.set(key, { key, value, secret: true });
  }

  return { vars: [...vars.values()], skipped };
}
