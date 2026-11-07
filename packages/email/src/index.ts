/**
 * @dockify/email: transactional email for Dockify. Typed templates that render { subject, html,
 * text } in client-safe HTML, and the SMTP sender (smtp.ts).
 */
export { esc, maskEmail, safeUrl, utcTime, EmailInputError } from "./html.ts";
export {
  factIcon, render, whereText, type AppKind, type AppRef, type Block, type Brand, type Email, type EmailMessage, type FactIcon, type FactRow, type FactValue, type Theme,
} from "./layout.ts";
export {
  alert, deployFailed, emailChanged, invite, securityNotice, passwordChangeCode, passwordReset, previewNotice, testEmail, updateNotice, verifyEmail, CODE_MINUTES, RESET_MINUTES,
  type AlertInput, type AlertKind, type CodeInput, type DeployFailedInput, type DeviceCodeInput, type SecurityEvent, type SecurityNoticeInput, type EmailChangedInput,
  type InviteInput, type PasswordResetInput, type PreviewNoticeInput, type SecurityReleaseInfo, type TestEmailInput, type UpdateNoticeInput,
} from "./templates.ts";
export {
  createMailer, domainOf, formatFrom, LOGIN_REFUSED, mailPolicyFromEnv, MailError, readEmailConfig, serverProblem, SMTP_PORTS, tlsModeFor,
  type EmailConfig, type Mailer, type MailFailure, type MailField, type MailPolicy, type OutgoingEmail, type SmtpServer, type TlsMode,
} from "./smtp.ts";
