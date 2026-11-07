/**
 * The SMTP sender against a real server on a local socket: real framing, a real TLS handshake with a
 * throwaway CA, and the replies a mail server gives. Only the address rule's tests use a fake wire.
 */
import { createServer as createNet, type Server, type Socket } from "node:net";
import { createSecureContext, createServer as createTls, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { classify, createMailer, deliver, domainOf, formatFrom, mailPolicyFromEnv, MailError, pinServer, readEmailConfig, serverProblem, SMTP_PORTS, stableMessageId, tlsModeFor, verify, type MailPolicy, type OutgoingEmail, type SmtpTarget } from "./smtp.ts";

// A throwaway CA and a certificate for mail.test.example, made for this test alone.
const CA = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUXaFrq78eW5vmuIbmIMohrXOtXKwwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRRG9ja2lmeSBUZXN0IFJvb3QwIBcNMjYxMTA2MTUwNDM5
WhgPMjEyNjEwMTMxNTA0MzlaMBwxGjAYBgNVBAMMEURvY2tpZnkgVGVzdCBSb290
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1dpMLCfiIk0MyAVHjnmR
5fKJbb9+nz2g7mBSgOsIVQzKTXjLsKo6fZ8RlHkBEoXBzdkjDxSkt2j5Pl5c78y/
vT5i0SU3mPHl4vgA6S4VAS94M0ZfmH9EP1MezHsnciIBgD+ohyEbCiIzhVmzOGQJ
02IP64FypWCfoL95CMEsYdStWXpcCZHbuU/5B1M1voyyH099AMLkVBYzXw/nkG4P
e2aPt9D+4Mj+d1gIs3mhSJzmU7e8GuqmEDk43WMrYxnYu6j9xjwRMzfOOTjOk1HA
OYnRHdDWjxafiT3h1hiYLD/TPX8jADqpN2FALSIJX9YsW+xHboL6ZjgmJLcJZBsn
bQIDAQABo2MwYTAdBgNVHQ4EFgQU7YG57EmsKvF+ZQJXsPtT+LYoYcQwHwYDVR0j
BBgwFoAU7YG57EmsKvF+ZQJXsPtT+LYoYcQwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAgQwDQYJKoZIhvcNAQELBQADggEBAMEoUkzoMyUQve+vh4kB6CCY
ArIFBD2xml8KI8jkqnRr2S2gbk/o0w9PedWCH179tiZMW5RguNMKw5JPMX5+WaDK
hpT/oDjAs03DARCsYVaO00th510ByzufNznATEyIdnQYIHpQkwoTtXabq1d9myJ/
rgShSPWxWWGN1pjeU/6rHEF8iKzVIROQGygtn3TN8j+rLkj3DNfweArILkmSI3Sc
mRW+VZWZwvz7aOZxlbFK/QC8Kifbolshix6PBSApJJwjGTH4+bzE/2eK4Ati7FE1
1h9tuDaQNmxPNDcaV4iFBLm1v62z9PqMwwuMS/Ld+Gt5xE9JhDL9N6ifIvtgb4s=
-----END CERTIFICATE-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIUdzENGWQZJhQsMzftrMKVVRKg+IMwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRRG9ja2lmeSBUZXN0IFJvb3QwIBcNMjYxMTA2MTUwNDM5
WhgPMjEyNjEwMTMxNTA0MzlaMBwxGjAYBgNVBAMMEW1haWwudGVzdC5leGFtcGxl
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4/58hZNiI4HOwMLVfAml
34czg2dzzJ5KkjQC9B1WDbd2QoqzOW0KBZq9tsPPbJrPCJ9xRxva3yoD9HescHZJ
zqFzyL+ONGTuMcAW023wRTEW2J2I1L600G3IJ4SnfB1akVI6qPp0NfWeZmKzc0CZ
bdRrBbALtN7a5yhbFiNDzkNnkCrpJN1rJrlaQiJ7Z8aAkIKTfg+gUiEO3myPvMJv
v+rZAHyZ+UNb28NnaNCnK+UCqKeIJ05N4t7W6TWv8Ln2ut7j3CMS1G7CGHwHGgmZ
4kLVwX9zNElBi8sKbSaCpkbhPRxa+54h9OC5z88xm4hGR/hvKh+idKgPmoFNzsHa
pwIDAQABo3UwczAcBgNVHREEFTATghFtYWlsLnRlc3QuZXhhbXBsZTATBgNVHSUE
DDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU2NlqrOCZPCOOcMi7wtulrRe+c9MwHwYD
VR0jBBgwFoAU7YG57EmsKvF+ZQJXsPtT+LYoYcQwDQYJKoZIhvcNAQELBQADggEB
AEXAtNdge8VPewZw1QU4aZvueCBg4hp9VJzNJZHCSV7vwJiN4ljzGBg1R6mgWSXi
Z1ZF4X4G7o5CWB0iaXZfvSKYlIwIpJAP6fWS3AaLPFjeiFp0gcCHc1qZ1SBFUz+Y
6V+Qi6zdXREVekchayX0wvxwYB1Lbkjmth+b7owYWxN2BlyvPPiLifFPNwboMlTc
79cZ7BZ8nFrI1n0ovLv4UQ8UWjmFfKb4uEPwVqlyMoxwWoxZnpZrWuYqEq69EQeI
LMPIiSKPDyqbv7Nu7ZPtcBnhsh4kcGJh2PqtN/uKIn4qnVBCpk+JrW94a5oiAPh3
eaQ8uEX5zvpK4dxaoy2tJIY=
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDj/nyFk2Ijgc7A
wtV8CaXfhzODZ3PMnkqSNAL0HVYNt3ZCirM5bQoFmr22w89sms8In3FHG9rfKgP0
d6xwdknOoXPIv440ZO4xwBbTbfBFMRbYnYjUvrTQbcgnhKd8HVqRUjqo+nQ19Z5m
YrNzQJlt1GsFsAu03trnKFsWI0POQ2eQKukk3WsmuVpCIntnxoCQgpN+D6BSIQ7e
bI+8wm+/6tkAfJn5Q1vbw2do0Kcr5QKop4gnTk3i3tbpNa/wufa63uPcIxLUbsIY
fAcaCZniQtXBf3M0SUGLywptJoKmRuE9HFr7niH04LnPzzGbiEZH+G8qH6J0qA+a
gU3OwdqnAgMBAAECggEABHDWAxIKVM+387g3yUk00mRDRBl1P3SL1kouDowtu2mp
44TpFcLCcbaAYHly5lYjlzLn1W889aDPX+ke0jfzmxM4+p2Eiw+2NgDcUPTwu6BH
piN3YVFvmymwPtjOHFRECdWUr+rk7ZIhqjPc8+87rdB33y39JGI82EjIcWdxcCiF
huNTi1Wwsd/5GwAv0uZWixOpztqttXFMxI/YI4oGDvt7aYe4eZGgtyNS+wRKLCzX
dcUchjxkNRPtsl1kv+jwWjM36ynMiHU2yTNv8uTr2xCaH1BwzMhzZc6bOPR1fpM3
1OD/Zf1IkuhMkZB/EL/yirrXiD19pMrx7dFyPJwRWQKBgQD5RijEIXpPlq9PNjBm
AhMIMeFvZSnUlQwX9AAQWBPS02zJcH2e66fVZCQMb5A7R9F4xb1q0E5fCPNurezl
tewZX4XIDHeqsIK7mXW8BUlcqAHC+41DQ9Y1YIC1od4IorU7mlEHinkgY7xD4MYl
Wt8lXOkRg73hVTgpfZ2K8XQ8KQKBgQDqJVZjc6WvDYyA+W/DJ7L68ZcJUg5+mnxO
FOrnM1CJRNNqTuQ02nJ0xAYDKlTwj4rWeTYQPAr5fIl8BuxQb5xgfNNRrqK+bMWS
S6OxmFYzAJrhp9nl5F3Az709UVA1OBHqmugmOI2uABI3MIBZHQ+M4MFMyZLPzmXT
tbuKTHI6TwKBgD/Wx/ny2PApFxyiNCLrxRQEMkflEKFwyngX9Sw6YllL7EBqnsFk
eMcdrl3A9J859VuIyMniLzAHitB9mn356U1WOVzSVJNSQSjqVEyizfb8z/avla30
YZep70yU99geU2vASaA0xnCVGlIH7rcCXsOi1820f5yFxqxZj09WJv6BAoGAHdxh
JhHLoYWS06f8DuFzO/mvj2q9mnvNOpAEXTP4I2l5pOcmx27MhgOx2Jl/d6Z2yF9w
+6UMqUCur/iaDrANO2jv8kzZSHvKvpuS5sVMyPhcyEaFzYHQSxSzR6ylFARwlIDo
9mbj+rrbl9pBpBvGrerD/C0A4iuqZNOadUrGjpUCgYAyb5m7yoaoKS+1BZ+EMwho
dITEfluSgl4iTDb7cHOc0GyKVQiv2EH8TybFQEfEHhkCuZ4Gyb9qT1mCqCUYPM2/
sJy0agNvhqBQ1EiFSENT46Womgv8EeP/5gHBP4GKl0lnB0x4L9KPxbBQlJW+7uU3
fkQqV89SCGcpCtx8tu142Q==
-----END PRIVATE KEY-----`;

const PASSWORD = "s3cret-Passw0rd-value";
const USER = "mailer";

interface Script {
  mode: "implicit" | "starttls";
  /** Do not offer STARTTLS at all. */
  noStarttls?: boolean;
  /** Answer STARTTLS with this instead of upgrading. */
  starttlsReply?: string;
  authReply?: string;
  mailReply?: string;
  rcptReply?: (to: string) => string;
  dataReply?: string;
  /** Accept the connection and never say anything. */
  silent?: boolean;
  /** Greet one byte at a time, for ever. */
  drip?: boolean;
}

interface Seen {
  /** Every command in order, with whether it arrived over TLS. */
  commands: Array<{ line: string; secure: boolean }>;
  data: string[];
}

const servers: Server[] = [];
const open = new Set<Socket>();
afterEach(async () => {
  for (const s of open) s.destroy();
  open.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function server(script: Script): Promise<{ port: number; seen: Seen }> {
  const seen: Seen = { commands: [], data: [] };
  const context = createSecureContext({ key: KEY, cert: CERT });
  const talk = (raw: Socket, secure: boolean, greet: boolean): void => {
    open.add(raw);
    raw.on("error", () => undefined);
    if (script.silent) return;
    if (script.drip) {
      const t = setInterval(() => raw.writable && raw.write("2"), 20);
      raw.on("close", () => clearInterval(t));
      return;
    }
    let buf = "";
    let inData = false;
    let body = "";
    const say = (s: string) => raw.write(`${s}\r\n`);
    if (greet) say("220 mail.test.example ESMTP");
    const onLine = (line: string): void => {
      if (inData) {
        if (line === ".") {
          inData = false;
          seen.data.push(body);
          body = "";
          say(script.dataReply ?? "250 2.0.0 queued");
        } else body += `${line}\n`;
        return;
      }
      seen.commands.push({ line, secure });
      const verb = line.split(/[ :]/)[0]!.toUpperCase();
      if (verb === "EHLO") {
        const lines = ["250-mail.test.example", ...(!secure && script.mode === "starttls" && !script.noStarttls ? ["250-STARTTLS"] : []), "250 AUTH PLAIN LOGIN"];
        for (const l of lines) say(l);
      } else if (verb === "STARTTLS") {
        if (script.starttlsReply || script.noStarttls) {
          say(script.starttlsReply ?? "502 not supported");
          return;
        }
        say("220 go ahead");
        raw.removeAllListeners("data");
        talk(new TLSSocket(raw, { isServer: true, secureContext: context }), true, false);
      } else if (verb === "AUTH") say(script.authReply ?? "235 ok");
      else if (verb === "MAIL") say(script.mailReply ?? "250 ok");
      else if (verb === "RCPT") say(script.rcptReply?.(line) ?? "250 ok");
      else if (verb === "DATA") {
        inData = true;
        say("354 go");
      } else if (verb === "QUIT") {
        say("221 bye");
        raw.end();
      } else say("502 no");
    };
    raw.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
  };
  const s: Server = script.mode === "implicit"
    ? createTls({ key: KEY, cert: CERT }, (c) => talk(c, true, true))
    : createNet((c) => talk(c, false, true));
  s.on("tlsClientError", () => undefined);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as { port: number }).port, seen };
}

const target = (port: number, over: Partial<SmtpTarget> = {}): SmtpTarget => ({
  host: "mail.test.example", address: "127.0.0.1", port, tlsMode: "starttls", username: USER, password: PASSWORD, ca: CA, ...over,
});
const MAIL: OutgoingEmail = { fromName: "Acme ops", fromAddress: "ops@acme.dev", to: "someone@example.com", replyTo: "help@acme.dev", subject: "Hello there", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "job-1" };
const refusal = async (p: Promise<unknown>): Promise<MailError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MailError);
    return e as MailError;
  }
  throw new Error("expected a refusal");
};
const verbs = (seen: Seen) => seen.commands.map((c) => c.line.split(/[ :]/)[0]!.toUpperCase());
const wireHeaders = (raw: string) => raw.slice(0, raw.indexOf("\n\n")).replace(/\n[ \t]+/g, " ").split("\n");

describe("delivery over a real socket", () => {
  it("sends over implicit TLS with the login, envelope, headers and body in order", async () => {
    const { port, seen } = await server({ mode: "implicit" });
    const out = await deliver(target(port, { tlsMode: "implicit" }), MAIL);
    expect(out.id).toBe(stableMessageId("job-1", "ops@acme.dev"));
    expect(seen.commands.every((c) => c.secure)).toBe(true);
    expect(verbs(seen).slice(0, 5)).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
    // The EHLO names the sending domain, never the container.
    expect(seen.commands[0]!.line).toBe("EHLO acme.dev");
    expect(seen.commands.find((c) => c.line.startsWith("MAIL"))!.line).toContain("<ops@acme.dev>");
    expect(seen.commands.find((c) => c.line.startsWith("RCPT"))!.line).toContain("<someone@example.com>");
    const raw = seen.data[0]!;
    const h = wireHeaders(raw);
    expect(h).toContain("From: Acme ops <ops@acme.dev>");
    expect(h).toContain("To: someone@example.com");
    expect(h).toContain("Reply-To: help@acme.dev");
    expect(h).toContain("Subject: Hello there");
    expect(h).toContain(`Message-ID: ${out.id}`);
    expect(h.some((l) => /^X-Mailer/i.test(l))).toBe(false);
    expect(raw).toContain("<p>Hi</p>");
  });

  it("over STARTTLS, nothing but EHLO and STARTTLS crosses before the upgrade", async () => {
    const { port, seen } = await server({ mode: "starttls" });
    await deliver(target(port), MAIL);
    const plain = seen.commands.filter((c) => !c.secure).map((c) => c.line.split(" ")[0]);
    expect(plain).toEqual(["EHLO", "STARTTLS"]);
    expect(verbs(seen)).toEqual(expect.arrayContaining(["AUTH", "MAIL", "RCPT", "DATA"]));
    expect(seen.data).toHaveLength(1);
  });

  it("the same key gives the same Message-ID on every attempt", async () => {
    const { port, seen } = await server({ mode: "implicit" });
    const t = target(port, { tlsMode: "implicit" });
    await deliver(t, MAIL);
    await deliver(t, MAIL);
    const ids = seen.data.map((d) => wireHeaders(d).find((l) => l.startsWith("Message-ID")));
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
  });

  it("refuses a server that does not offer STARTTLS, before any login or mail", async () => {
    const { port, seen } = await server({ mode: "starttls", noStarttls: true });
    const e = await refusal(deliver(target(port), MAIL));
    expect(e.kind).toBe("tls");
    expect(e.field).toBe("tlsMode");
    expect(e.retry).toBe(true);
    expect(e.settingsRefused).toBe(false);
    expect(e.message).toContain("mail.test.example on port");
    expect(verbs(seen)).not.toContain("AUTH");
    expect(verbs(seen)).not.toContain("MAIL");
    expect(seen.data).toHaveLength(0);
  });

  it("refuses a server that answers STARTTLS with an error, before any login or mail", async () => {
    const { port, seen } = await server({ mode: "starttls", starttlsReply: "454 TLS not available" });
    const e = await refusal(deliver(target(port), MAIL));
    expect(e.kind).toBe("tls");
    expect(verbs(seen)).not.toContain("AUTH");
    expect(verbs(seen)).not.toContain("MAIL");
  });

  it("verifies the certificate against the name, not the address, in both modes", async () => {
    for (const mode of ["implicit", "starttls"] as const) {
      const { port, seen } = await server({ mode });
      const wrongName = await refusal(deliver(target(port, { tlsMode: mode, host: "other.test.example" }), MAIL));
      expect(wrongName.kind, mode).toBe("tls");
      expect(verbs(seen), mode).not.toContain("AUTH");
      // No private CA: the system roots do not know this certificate.
      const untrusted = await refusal(deliver({ ...target(port, { tlsMode: mode }), ca: undefined }, MAIL));
      expect(untrusted.kind, mode).toBe("tls");
      expect(verbs(seen), mode).not.toContain("AUTH");
    }
  });

  it("a plain port given implicit TLS fails, and credentials never leave", async () => {
    const { port, seen } = await server({ mode: "starttls" });
    const e = await refusal(deliver(target(port, { tlsMode: "implicit" }), MAIL, { deadlineMs: 3000 }));
    expect(["tls", "unreachable"]).toContain(e.kind);
    expect(verbs(seen)).not.toContain("AUTH");
  });

  it.each(["535 5.7.8 bad login", "534 5.7.9 app password required", "530 5.7.0 authentication required"])("%s marks the settings and does not retry", async (authReply) => {
    const { port, seen } = await server({ mode: "implicit", authReply });
    const e = await refusal(deliver(target(port, { tlsMode: "implicit" }), MAIL));
    expect(e).toMatchObject({ kind: "auth", field: "password", retry: false, settingsRefused: true });
    expect(e.message).toMatch(/username and password/);
    expect(verbs(seen)).not.toContain("MAIL");
  });

  it("a 454 at login is the server's trouble, not the password's", async () => {
    const { port } = await server({ mode: "implicit", authReply: "454 4.7.0 try later" });
    const e = await refusal(deliver(target(port, { tlsMode: "implicit" }), MAIL));
    expect(e).toMatchObject({ kind: "busy", retry: true, settingsRefused: false });
  });

  it("never lets the password out through a server that echoes it", async () => {
    const encoded = Buffer.from(`\0${USER}\0${PASSWORD}`).toString("base64");
    const { port } = await server({ mode: "implicit", authReply: `535 bad login ${PASSWORD} and ${encoded}` });
    const e = await refusal(deliver(target(port, { tlsMode: "implicit" }), MAIL));
    for (const text of [e.message, e.detail ?? "", JSON.stringify(e), String(e)]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(encoded);
    }
    expect(e.detail).toContain("535 bad login");
  });

  it.each(["550 5.1.1 no such user", "551 not local", "553 bad mailbox"])("%s fails that send only", async (reply) => {
    const { port, seen } = await server({ mode: "implicit", rcptReply: () => reply });
    const e = await refusal(deliver(target(port, { tlsMode: "implicit" }), MAIL));
    expect(e).toMatchObject({ kind: "recipient", retry: false, settingsRefused: false, noConnection: false, smtpCode: Number(reply.slice(0, 3)) });
    expect(seen.data).toHaveLength(0);
  });

  it("a 451 at the recipient or after the data retries", async () => {
    const a = await server({ mode: "implicit", rcptReply: () => "451 4.3.0 greylisted" });
    expect(await refusal(deliver(target(a.port, { tlsMode: "implicit" }), MAIL))).toMatchObject({ kind: "busy", retry: true, settingsRefused: false, smtpCode: 451 });
    const b = await server({ mode: "implicit", dataReply: "451 4.3.0 try later" });
    expect(await refusal(deliver(target(b.port, { tlsMode: "implicit" }), MAIL))).toMatchObject({ kind: "busy", retry: true });
  });

  it("a refused from address names its field, and a refused message is that message's failure", async () => {
    const a = await server({ mode: "implicit", mailReply: "553 sender not verified" });
    expect(await refusal(deliver(target(a.port, { tlsMode: "implicit" }), MAIL))).toMatchObject({ kind: "sender", field: "fromAddress", retry: false, settingsRefused: false });
    const b = await server({ mode: "implicit", dataReply: "554 5.7.1 looks like spam" });
    expect(await refusal(deliver(target(b.port, { tlsMode: "implicit" }), MAIL))).toMatchObject({ kind: "rejected", retry: false, settingsRefused: false, detail: "554 5.7.1 looks like spam" });
  });

  it("says plainly when the port cannot be reached", async () => {
    const closed = createNet();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise((r) => closed.close(r));
    const e = await refusal(deliver(target(port), MAIL));
    expect(e).toMatchObject({ kind: "unreachable", field: "port", retry: true, settingsRefused: false, noConnection: true });
    expect(e.message).toBe(`Could not reach mail.test.example on port ${port}. Many VPS providers block outbound mail ports. Try the provider's alternate port, such as 2465 or 2587 for Resend, or ask your VPS provider to open it.`);
  });

  it("a server that says nothing cannot hold the sender", async () => {
    const { port } = await server({ mode: "starttls", silent: true });
    const started = Date.now();
    const e = await refusal(deliver(target(port), MAIL, { greetingMs: 150, connectMs: 150, quietMs: 150 }));
    expect(e.kind).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a server that drips bytes hits the deadline over the whole exchange", async () => {
    const { port } = await server({ mode: "starttls", drip: true });
    const started = Date.now();
    const e = await refusal(deliver(target(port), MAIL, { deadlineMs: 300, quietMs: 10_000, greetingMs: 10_000 }));
    expect(e.kind).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("verify logs in and sends nothing", async () => {
    const { port, seen } = await server({ mode: "implicit" });
    await verify(target(port, { tlsMode: "implicit" }));
    expect(verbs(seen)).toContain("AUTH");
    expect(verbs(seen)).not.toContain("MAIL");
    const bad = await server({ mode: "implicit", authReply: "535 no" });
    expect(await refusal(verify(target(bad.port, { tlsMode: "implicit" })))).toMatchObject({ kind: "auth" });
  });
});

describe("header injection", () => {
  it("no field can add a header line", async () => {
    const { port, seen } = await server({ mode: "implicit" });
    await deliver(target(port, { tlsMode: "implicit" }), {
      ...MAIL,
      fromName: 'Ops\r\nBcc: evil@example.com\r\nX-Evil: 1 "<x>"',
      subject: "Hello\r\nBcc: evil@example.com\nX-Evil: 2 X-Evil: 3",
    });
    const h = wireHeaders(seen.data[0]!);
    expect(h.filter((l) => /^(Bcc|X-Evil):/i.test(l))).toEqual([]);
    expect(h.filter((l) => /^From:/i.test(l))).toHaveLength(1);
    expect(h.filter((l) => /^Subject:/i.test(l))).toHaveLength(1);
    expect(verbs(seen).filter((v) => v === "RCPT")).toHaveLength(1);
    expect(seen.commands.some((c) => c.line.includes("evil@"))).toBe(false);
  });

  it("refuses an address with a line break or a second address in it, before connecting", async () => {
    const dead = target(1);
    for (const to of ["a@b.co\r\nBcc: evil@example.com", "a@b.co, evil@example.com", "<a@b.co>", "a b@c.co", "nope"]) {
      expect(await refusal(deliver(dead, { ...MAIL, to })), to).toMatchObject({ kind: "recipient", retry: false });
    }
    expect(await refusal(deliver(dead, { ...MAIL, fromAddress: "a@b.co\nX: y" }))).toMatchObject({ kind: "sender", field: "fromAddress" });
    expect(await refusal(deliver(dead, { ...MAIL, replyTo: "a@b.co\r\nX: y" }))).toMatchObject({ kind: "rejected" });
  });

  it("formatFrom keeps a name on one quoted line", () => {
    expect(formatFrom('Ops "team"\r\nBcc: x', "a@b.co")).toBe('"Ops team Bcc: x" <a@b.co>');
    expect(formatFrom("", "a@b.co")).toBe("a@b.co");
  });
});

describe("the address rule", () => {
  const policy = (answers: string[], over: Partial<MailPolicy> = {}): MailPolicy & { lookups: string[] } => {
    const lookups: string[] = [];
    return { ownHosts: new Set(["dash.example.com"]), ownAddresses: new Set(["8.8.4.7"]), resolve: async (h) => (lookups.push(h), answers.map((address) => ({ address }))), lookups, ...over };
  };

  it.each([
    ["localhost", ["127.0.0.1"]], ["postgres", ["172.30.2.10"]], ["smtp.internal", ["8.8.8.8"]], ["metadata.google.internal", ["169.254.169.254"]],
    ["169.254.169.254", []], ["10.0.0.1", []], ["[::1]", []], ["127.0.0.1", []],
    ["evil.example.com", ["10.0.0.5"]], ["evil.example.com", ["127.0.0.1"]], ["evil.example.com", ["169.254.169.254"]], ["evil.example.com", ["100.100.100.200"]],
    ["evil.example.com", ["fd00::1"]], ["evil.example.com", ["::ffff:10.0.0.1"]],
    // One bad answer among good ones is the rebinding shape.
    ["evil.example.com", ["8.8.8.8", "10.0.0.5"]],
  ])("refuses %s answering %j", async (host, answers) => {
    expect(await refusal(pinServer(host, 465, policy(answers)))).toMatchObject({ kind: "blocked", field: "host", retry: false, settingsRefused: true });
  });

  it("refuses this control plane's own names and addresses", async () => {
    expect(await refusal(pinServer("DASH.example.com.", 587, policy(["8.8.8.8"])))).toMatchObject({ kind: "blocked", field: "host" });
    expect(await refusal(pinServer("alias.example.com", 587, policy(["8.8.4.7"])))).toMatchObject({ kind: "blocked", field: "host" });
  });

  it("says when a name has no address", async () => {
    expect(await refusal(pinServer("nope.example.com", 587, policy([])))).toMatchObject({ kind: "dns", field: "host", retry: true });
    const failing = policy([], { resolve: async () => { throw new Error("ENOTFOUND"); } });
    expect(await refusal(pinServer("nope.example.com", 587, failing))).toMatchObject({ kind: "dns" });
  });

  it("refuses every port outside the small set", async () => {
    for (const port of [0, 22, 80, 443, 2375, 3001, 5432, 6379, 8080, 65535]) {
      expect(serverProblem("smtp.example.com", port, policy([])), String(port)).toMatchObject({ kind: "blocked", field: "port" });
      expect(await refusal(pinServer("smtp.example.com", port, policy(["8.8.8.8"]))), String(port)).toMatchObject({ field: "port" });
    }
    for (const port of SMTP_PORTS) expect(serverProblem("smtp.example.com", port, policy([])), String(port)).toBeNull();
    expect(SMTP_PORTS).toEqual([25, 465, 587, 2465, 2525, 2587]);
  });

  it("dials the one checked address and keeps the name, resolving once, so DNS cannot move it", async () => {
    const sent: SmtpTarget[] = [];
    const p = policy(["2606:4700::1", "8.8.4.4"]);
    const mailer = createMailer(p, { deliver: async (t) => (sent.push(t), { id: "x" }), verify: async (t) => void sent.push(t) });
    await mailer.send({ host: "smtp.example.com", port: 465, tlsMode: "implicit", username: "u", password: "p" }, { ...MAIL, idempotencyKey: undefined });
    expect(sent[0]).toMatchObject({ address: "8.8.4.4", host: "smtp.example.com" });
    expect(p.lookups).toEqual(["smtp.example.com"]);
    await mailer.verify({ host: "smtp.example.com", port: 465, tlsMode: "implicit", username: "u", password: "p" });
    expect(sent[1]).toMatchObject({ address: "8.8.4.4" });
  });

  it("does not touch the wire for a refused host", async () => {
    const mailer = createMailer(policy(["10.0.0.1"]), { deliver: async () => { throw new Error("dialled"); }, verify: async () => { throw new Error("dialled"); } });
    const server = { host: "smtp.example.com", port: 465, tlsMode: "implicit" as const, username: "u", password: "p" };
    expect(await refusal(mailer.send(server, MAIL))).toMatchObject({ kind: "blocked" });
    expect(await refusal(mailer.verify(server))).toMatchObject({ kind: "blocked" });
  });

  it("remembers what a server accepted, so a retried job skips it, and only that", async () => {
    let tries = 0;
    let fail = false;
    const mailer = createMailer(policy(["8.8.8.8"]), {
      deliver: async () => {
        tries += 1;
        if (fail) throw new MailError("busy", "busy");
        return { id: "x" };
      },
      verify: async () => undefined,
    });
    const server = { host: "smtp.example.com", port: 465, tlsMode: "implicit" as const, username: "u", password: "p" };
    await mailer.send(server, { ...MAIL, idempotencyKey: "a" });
    await mailer.send(server, { ...MAIL, idempotencyKey: "a" });
    expect(tries).toBe(1);
    fail = true;
    await expect(mailer.send(server, { ...MAIL, idempotencyKey: "b" })).rejects.toBeInstanceOf(MailError);
    fail = false;
    await mailer.send(server, { ...MAIL, idempotencyKey: "b" });
    expect(tries).toBe(3);
    // No key, no memory: a test send always goes out.
    await mailer.send(server, { ...MAIL, idempotencyKey: undefined });
    await mailer.send(server, { ...MAIL, idempotencyKey: undefined });
    expect(tries).toBe(5);
  });

  it("builds its names from the environment", () => {
    const p = mailPolicyFromEnv({ DOCKIFY_PUBLIC_URL: "https://Dash.Example.com/", DOCKIFY_RESERVED_HOSTS: "a.example.com, B.example.com.", DOCKIFY_SERVER_IPV4: "8.8.4.7", DOCKIFY_SERVER_IPV6: "" });
    expect([...p.ownHosts].sort()).toEqual(["a.example.com", "b.example.com", "dash.example.com"]);
    expect([...p.ownAddresses]).toEqual(["8.8.4.7"]);
  });
});

describe("settings", () => {
  it("picks the TLS mode a port uses", () => {
    expect([25, 465, 587, 2465, 2525, 2587].map(tlsModeFor)).toEqual(["starttls", "implicit", "starttls", "implicit", "starttls", "starttls"]);
  });

  it("reads a row's config, and one that cannot send has no host", () => {
    expect(readEmailConfig({ host: "smtp.resend.com", port: 465, tlsMode: "implicit", username: "resend", fromName: "Ops", fromAddress: "a@b.co", replyTo: null })).toEqual({ host: "smtp.resend.com", port: 465, tlsMode: "implicit", username: "resend", fromName: "Ops", fromAddress: "a@b.co", replyTo: null });
    expect(readEmailConfig({ port: 2587 }).tlsMode).toBe("starttls");
    for (const bad of [null, [], "x", {}]) expect(readEmailConfig(bad).host).toBe("");
    // An unknown mode can never mean no TLS.
    expect(readEmailConfig({ port: 465, tlsMode: "off" }).tlsMode).toBe("implicit");
  });

  it("classifies what has no reply code", () => {
    const c = (code: string, message = "x") => classify(Object.assign(new Error(message), { code }), "h.example.com", 587, "u", "p4ssword");
    expect(c("ETIMEDOUT").kind).toBe("unreachable");
    expect(c("ESOCKET").kind).toBe("unreachable");
    expect(c("ECONNECTION").kind).toBe("unreachable");
    expect(c("EDNS").kind).toBe("dns");
    expect(c("ETLS").kind).toBe("tls");
    expect(c("CERT_HAS_EXPIRED").kind).toBe("tls");
    expect(c("ESOCKET", "self-signed certificate in certificate chain").kind).toBe("tls");
    expect(domainOf("A@Mail.Example.COM")).toBe("mail.example.com");
  });
});
