/* What the email form checks before it calls the API; the API route runs the same checks again. A
   preset only fills fields: nothing past this list knows a provider. */

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const FROM_NAME = /^[^"<>\\\r\n]{1,60}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type EmailTlsMode = "implicit" | "starttls";

/** Mirrors SMTP_PORTS in packages/email: the only ports Dockify connects to. */
export const EMAIL_PORTS = [25, 465, 587, 2465, 2525, 2587] as const;

/** Implicit TLS on 465 and 2465, STARTTLS everywhere else. */
export const tlsModeFor = (port: number): EmailTlsMode => (port === 465 || port === 2465 ? "implicit" : "starttls");

export interface EmailPreset {
  id: string;
  label: string;
  host: string;
  port: number;
  /** Filled in when the provider has a fixed username. */
  username: string;
  /** What this provider calls the username and the password. */
  usernameHint: string;
  passwordHint: string;
}

export const EMAIL_PRESETS: EmailPreset[] = [
  { id: "resend", label: "Resend", host: "smtp.resend.com", port: 465, username: "resend", usernameHint: "Always resend.", passwordHint: "Your Resend API key." },
  { id: "gmail", label: "Gmail", host: "smtp.gmail.com", port: 587, username: "", usernameHint: "Your full Gmail address.", passwordHint: "An app password from your Google account, not your sign-in password." },
  { id: "ses", label: "Amazon SES", host: "email-smtp.us-east-1.amazonaws.com", port: 587, username: "", usernameHint: "Your SES SMTP username.", passwordHint: "Your SES SMTP password. Change the region in the host if yours differs." },
  { id: "mailgun", label: "Mailgun", host: "smtp.mailgun.org", port: 587, username: "", usernameHint: "The SMTP login of your domain.", passwordHint: "That login's password. EU domains use smtp.eu.mailgun.org." },
  { id: "postmark", label: "Postmark", host: "smtp.postmarkapp.com", port: 587, username: "", usernameHint: "Your server API token.", passwordHint: "The same server API token." },
  { id: "sendgrid", label: "SendGrid", host: "smtp.sendgrid.net", port: 587, username: "apikey", usernameHint: "Always apikey.", passwordHint: "Your SendGrid API key." },
  { id: "brevo", label: "Brevo", host: "smtp-relay.brevo.com", port: 587, username: "", usernameHint: "Your Brevo SMTP login.", passwordHint: "Your Brevo SMTP key." },
];

/** The preset a host belongs to, so the picker follows the field. */
export const presetOfHost = (host: string): EmailPreset | null => EMAIL_PRESETS.find((p) => p.host === host.trim().toLowerCase()) ?? null;

export interface EmailFormValues {
  host: string;
  port: number;
  tlsMode: EmailTlsMode;
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

/** What is stored already: a blank password keeps it, only for the host and username it was saved for. */
export interface StoredLogin {
  host: string;
  username: string;
  hasPassword: boolean;
}

/** Whether a blank password would keep the stored one. */
export const keepsPassword = (v: Pick<EmailFormValues, "host" | "username">, stored: StoredLogin | null): boolean =>
  !!stored?.hasPassword && stored.host === v.host.trim().toLowerCase() && stored.username === v.username.trim();

/** The problem with each field, or null. */
export function emailFormErrors(v: EmailFormValues, stored: StoredLogin | null) {
  const replyTo = v.replyTo.trim();
  const username = v.username.trim();
  return {
    host: HOST.test(v.host.trim().toLowerCase()) ? null : "Enter the mail server's host name, like smtp.example.com",
    port: (EMAIL_PORTS as readonly number[]).includes(v.port) ? null : `Use one of the mail ports: ${EMAIL_PORTS.join(", ")}`,
    tlsMode: v.tlsMode === "implicit" || v.tlsMode === "starttls" ? null : "Pick how the connection is encrypted",
    username: username && username.length <= 254 && !/[\r\n]/.test(username) ? null : "Enter the username",
    password: /[\r\n]/.test(v.password) || v.password.length > 1024
      ? "Enter the password on one line"
      : v.password || keepsPassword(v, stored)
        ? null
        : stored?.hasPassword
          ? "Enter the password again: a stored password only goes to the server and username it was saved for"
          : "Enter the password",
    fromName: FROM_NAME.test(v.fromName.trim()) ? null : "Enter a name, without quotes or angle brackets",
    fromAddress: v.fromAddress.trim().length <= 254 && EMAIL.test(v.fromAddress.trim()) ? null : "Enter the address emails come from",
    replyTo: !replyTo || (replyTo.length <= 254 && EMAIL.test(replyTo)) ? null : "Enter a valid address, or leave it empty",
  };
}

export type EmailFormField = keyof ReturnType<typeof emailFormErrors>;

/** The field an API refusal names. */
export const EMAIL_ERROR_FIELD: Record<string, EmailFormField> = {
  EMAIL_HOST: "host",
  EMAIL_PORT: "port",
  EMAIL_TLS: "tlsMode",
  EMAIL_LOGIN: "password",
  EMAIL_FROM: "fromAddress",
};
