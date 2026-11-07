import { integrations } from "@dockify/contracts";
import { SMTP_PORTS, tlsModeFor } from "@dockify/email";
import { describe, expect, it } from "vitest";

describe("email contract", () => {
  it("takes exactly the ports the sender dials, and no TLS mode that is not TLS", () => {
    expect(integrations.EmailPort.options.map((o) => o.value)).toEqual([...SMTP_PORTS]);
    expect(integrations.EmailTlsMode.options).toEqual(["implicit", "starttls"]);
    for (const port of SMTP_PORTS) expect(integrations.EmailTlsMode.options).toContain(tlsModeFor(port));
  });

  it("keeps a line break out of everything that becomes a header or an SMTP command", () => {
    const good = { host: "smtp.example.com", port: 465, tlsMode: "implicit", username: "u", password: "p", fromName: "Ops", fromAddress: "a@b.co" };
    expect(integrations.EmailConnectBody.safeParse(good).success).toBe(true);
    for (const bad of [
      { fromName: "Ops\r\nBcc: x@y.co" }, { fromName: 'Ops "team"' }, { fromAddress: "a@b.co\r\nBcc: x@y.co" }, { replyTo: "a@b.co\nX: y" },
      { username: "u\r\nMAIL FROM:<x>" }, { password: "p\r\nQUIT" }, { host: "smtp.example.com\r\nX" }, { host: "10.0.0.1" }, { host: "localhost" },
      { port: 22 }, { port: 443 }, { port: "465" }, { tlsMode: "none" }, { tlsMode: "off" }, { apiKey: "re_x" },
    ]) expect(integrations.EmailConnectBody.safeParse({ ...good, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
});
