import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { CopyButton } from "@/components/ui/copy-button";
import { IconTile } from "@/components/ui/icon-tile";
import { AuthHead } from "./auth-head";

/** The host CLI (apps/api/src/admin.ts) through the `dockify` wrapper; `<email>` is the account. */
const DISABLE_MFA = "sudo dockify admin disable-mfa <email>";
const RESET_PASSWORD = "sudo dockify admin reset-password <email>";

/** One command in a copyable block: `$`, the command, its `<email>` placeholder muted. */
export function Command({ command, what }: { command: string; what: string }) {
  const [head, tail] = command.split("<email>");
  return (
    <div className="auth-cmd">
      <code className="auth-cmd-text">
        <span className="auth-cmd-prompt" aria-hidden="true">
          $
        </span>
        {head}
        <span className="auth-cmd-arg">&lt;email&gt;</span>
        {tail}
      </code>
      <CopyButton value={command} what={what} align="end" />
    </div>
  );
}

function Block({ id, icon, title, children, command, what }: { id: string; icon: IconName; title: string; children: React.ReactNode; command: string; what: string }) {
  return (
    <section aria-labelledby={id}>
      <div className="auth-sub-row">
        <IconTile size="md">
          <Icon name={icon} />
        </IconTile>
        <div>
          <h2 id={id} className="auth-sub">
            {title}
          </h2>
          <p className="auth-text">{children}</p>
        </div>
      </div>
      <Command command={command} what={what} />
    </section>
  );
}

/**
 * /recover: the way back in. Whoever runs the server resets the account over SSH with the host
 * CLI. Turning two-factor off comes first, since a lost authenticator is what most often brings
 * someone here; a new password second. Both end every session of the account. With email set
 * up, a forgotten password can also use the emailed link.
 */
export function RecoverView({ emailEnabled = false }: { emailEnabled?: boolean }) {
  return (
    <section className="auth-block">
      <AuthHead
        icon="key"
        title="Recover access"
        lead="Whoever runs this server can get you back in over SSH. Each command takes the email you sign in with."
      />

      <div className="auth-cmds">
        <Block id="recover-mfa" icon="shield" title="Reset two-factor" command={DISABLE_MFA} what="two-factor reset command">
          For a lost or replaced authenticator. Turns two-factor off and signs the account out everywhere. Set it up again in
          Settings once you are in.
        </Block>
        <Block id="recover-password" icon="lock" title="Reset the password" command={RESET_PASSWORD} what="password reset command">
          Prints a new password and signs the account out everywhere. Two-factor stays on.
          {emailEnabled ? (
            <>
              {" "}
              Still have your inbox?{" "}
              <Link href="/forgot" className="auth-link">
                Get a reset link
              </Link>{" "}
              instead.
            </>
          ) : null}
        </Block>
      </div>

      <div className="auth-alt">
        <Link href="/login" className="auth-link auth-back">
          Back to sign in
        </Link>
      </div>
    </section>
  );
}
