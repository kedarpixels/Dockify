import type { Mailer, MailError, OutgoingEmail, SmtpServer } from "@dockify/email";

/** The stored row a test's email integration has: what loadSender needs to send. */
export const SMTP_ROW = { host: "smtp.example.com", port: 465, tlsMode: "implicit", username: "mailer" } as const;

/** A Mailer for tests: records every send and answers each with the failure `answer` picks, or success. */
export function fakeMailer(answer: (m: OutgoingEmail) => MailError | null = () => null) {
  const calls: OutgoingEmail[] = [];
  const servers: SmtpServer[] = [];
  const mail: Mailer = {
    send: async (server, m) => {
      calls.push(m);
      servers.push(server);
      const e = answer(m);
      if (e) throw e;
      return { id: "<id@example.com>" };
    },
    verify: async () => undefined,
  };
  return { mail, calls, servers, to: () => calls.map((c) => c.to), keys: () => calls.map((c) => c.idempotencyKey) };
}
