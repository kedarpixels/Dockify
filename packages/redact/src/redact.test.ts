import { describe, expect, it } from "vitest";
import { MARK, Redactor } from "./index.ts";

describe("redactor (one module for deploy and runtime logs)", () => {
  it("hides literal secrets, skips short values, and catches self-naming credentials", () => {
    const r = new Redactor().conceal(["s3cr3t-value", "true"]);
    expect(r.line("connecting with s3cr3t-value now")).toBe(`connecting with ${MARK} now`);
    expect(r.line("flag is true")).toBe("flag is true");
    expect(r.line("postgres://app:hunter22@db:5432/x")).toBe(`postgres://${MARK}@db:5432/x`);
    expect(r.line("API_KEY=abcdef123")).toBe(`API_KEY=${MARK}`);
    expect(r.line("Authorization: Bearer abcdefghijklmnop")).toContain(MARK);
    expect(r.line("AKIAIOSFODNN7EXAMPLE used")).toBe(`${MARK} used`);
    expect(r.line("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(`token ${MARK}`);
  });

  it("replaces the longest literal first so a prefix never leaves a tail behind", () => {
    const r = new Redactor().conceal(["abcdef", "abcdefghij"]);
    expect(r.line("x abcdefghij y")).toBe(`x ${MARK} y`);
  });

  it("swallows a PEM body", () => {
    const r = new Redactor();
    expect(r.line("-----BEGIN PRIVATE KEY-----")).toBe(MARK);
    expect(r.line("MIIEvQIBADANBg")).toBe(MARK);
    expect(r.line("-----END PRIVATE KEY-----")).toBe(MARK);
    expect(r.line("after")).toBe("after");
  });

  it("hides a long secret whole, never just its first few thousand characters", () => {
    const r = new Redactor();
    expect(r.line(`postgres://app:${"p".repeat(600)}@db:5432/x`)).toBe(`postgres://${MARK}@db:5432/x`);
    expect(r.line(`sending Bearer ${"t".repeat(5000)} upstream`)).toBe(`sending Bearer ${MARK} upstream`);
    expect(r.line(`API_KEY=${"k".repeat(5000)}`)).toBe(`API_KEY=${MARK}`);
    expect(r.line(`aws_secret_access_key=${"s".repeat(5000)}`)).toBe(`aws_secret_access_key=${MARK}`);
    expect(r.line(`password="${"q".repeat(5000)} more"`)).toBe(`password=${MARK}`);
  });

  it("matches a key name of any length that contains a keyword", () => {
    const r = new Redactor();
    for (const key of [`${"x".repeat(100)}_DB_PASSWORD`, `PASSWORD_${"x".repeat(100)}`, `${"x".repeat(1000)}_token`, `app.${"a.".repeat(300)}secret`]) {
      expect(r.line(`${key}=hunter2`), key.slice(0, 20)).toBe(`${key}=${MARK}`);
    }
  });

  it("still checks a value as a key when the key before it names no secret", () => {
    const r = new Redactor();
    expect(r.line("options: password=hunter2")).toBe(`options: password=${MARK}`);
    expect(r.line("--set foo=bar,password=hunter2")).toBe(`--set foo=bar,password=${MARK}`);
    expect(r.line("INFO: token=abc123")).toBe(`INFO: token=${MARK}`);
    expect(r.line('env: DB_PASSWORD="two words"')).toBe(`env: DB_PASSWORD=${MARK}`);
    expect(r.line("time=12:00:00 user=bob level=info")).toBe("time=12:00:00 user=bob level=info");
  });

  it("leaves a comma-separated list of key names alone, and still hides a value after one", () => {
    const r = new Redactor();
    // The build log lists secret key names this way (packages/engine/src/build.ts planLogLines).
    const line = "==> build secrets (read each with RUN --mount=type=secret,id=NAME): DB_PASSWORD, API_TOKEN, SECRET";
    expect(r.line(line)).toBe(line);
    // The rule itself is unchanged: a key naming a secret, then ":" or "=", hides what follows.
    expect(r.line("--mount=type=secret: DB_PASSWORD")).toBe(`--mount=type=secret=${MARK}`);
    expect(r.line("DB_PASSWORD: hunter2")).toBe(`DB_PASSWORD=${MARK}`);
  });

  it("keeps the old scheme rule for URLs: a scheme may follow other characters", () => {
    const r = new Redactor();
    expect(r.line("1postgres://u:p@h")).toBe(`1postgres://${MARK}@h`);
    expect(r.line(`-d${"a".repeat(40)}redis://u:p@h`)).toBe(`-d${"a".repeat(40)}redis://${MARK}@h`);
    expect(r.line("jdbc:postgresql://u:p@h/db")).toBe(`jdbc:postgresql://${MARK}@h/db`);
    expect(r.line("see https://example.com/a@b and ://u:p@h")).toBe("see https://example.com/a@b and ://u:p@h");
  });

  it("stays linear on hostile 16 KiB lines and still hides the secret in them", () => {
    const r = new Redactor();
    const fill = (unit: string) => unit.repeat(Math.ceil(16_384 / unit.length)).slice(0, 16_384);
    // "dsn." made the old {0,64}keyword{0,64} pattern take 27 ms per line, 500 times normal text.
    // Ten lines of each shape must take well under 5 ms a line; 50 ms for all ten leaves CI slack.
    for (const unit of ["dsn.", "a.", "passw", 'token:"', "a://b", "connection_strin", "Token "]) {
      const line = `${fill(unit)} password=hunter2-real-secret`;
      r.line(line);
      const out: string[] = [];
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) out.push(r.line(line));
      const ms = performance.now() - t0;
      expect(ms, unit).toBeLessThan(50);
      for (const o of out) {
        expect(o, unit).not.toContain("hunter2-real-secret");
        expect(o, unit).toContain(MARK);
      }
    }
  });

  it("leaves a path ending in a keyword alone, and still hides a real value", () => {
    const r = new Redactor();
    expect(r.line("ls: /run/secrets: No such file or directory")).toBe("ls: /run/secrets: No such file or directory");
    expect(r.line("cat: /app/config/token: Permission denied")).toBe("cat: /app/config/token: Permission denied");
    expect(r.line("secret: hunter2hunter2")).toBe(`secret=${MARK}`);
    expect(r.line("DB_PASSWORD: hunter2hunter2")).toBe(`DB_PASSWORD=${MARK}`);
    expect(r.line("/run/secrets=abc123")).toBe(`/run/secrets=${MARK}`);
    expect(r.line("https://x.example/login?password=abc123")).toBe(`https://x.example/login?password=${MARK}`);
  });
});
