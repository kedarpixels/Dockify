-- Email is SMTP only. A row from the Resend API days becomes Resend's SMTP service: its host, implicit
-- TLS on 465, the username Resend documents, and the sealed API key, untouched, as the password
-- (https://resend.com/docs/send-with-smtp). The secret row is not read or rewritten: its seal binds
-- its kind and owner, and those stay. The from address, name and reply-to stay; the domain status goes.
-- A row with no secret converts too, and says on its card that the password must be entered.
UPDATE "integrations"
SET
  "config" = ("config" - 'domain') || jsonb_build_object('host', 'smtp.resend.com', 'port', 465, 'tlsMode', 'implicit', 'username', 'resend'),
  "status" = CASE WHEN "secretId" IS NULL THEN 'error'::"IntegrationStatus" ELSE "status" END,
  "error" = CASE
    WHEN "secretId" IS NULL THEN 'The stored mail password is missing. Edit the settings and enter it'
    WHEN "error" = 'Resend refused the stored API key' THEN 'The mail server refused the stored username or password'
    ELSE "error"
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" = 'email'
  AND jsonb_typeof("config") = 'object'
  AND NOT ("config" ? 'host');
