import { AuthArt } from "@/components/auth/auth-art";
import { Icon } from "@/components/icon";
import { Rule, Spacer } from "@/components/ui/rule";
import { ThemeSwitch } from "@/components/ui/theme-switch";

/*
 * Signed-out pages (sign in, two-factor, recovery, first-run setup, invites) sit outside the
 * console shell: no sidebar, no Topbar. A ruled frame runs the full height: the brand and theme
 * switch at its head, the card row held between two dither bands in the middle, and a quiet foot
 * line closing it. From 880px the card row splits: the form on the left, the whale drawn in deploy
 * cells on the right, one hairline between them with a node where it meets each band. Narrower,
 * the frame is the form's column alone. Each page renders its blocks (`.auth-block`, `<Rule />`)
 * into the form cell, so every rule meets the rail and the divider on a node.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="page auth-page" id="main" tabIndex={-1}>
      <header className="auth-top">
        <span className="auth-brand">
          <img className="logo" src="/dockify-logo.png" alt="" width={33} height={24} />
          <span className="auth-brand-name">Dockify</span>
        </span>
        <ThemeSwitch tipAlign="end" />
      </header>
      <Rule />
      <div className="auth-fill" aria-hidden="true" />
      <Spacer />
      <div className="auth-split">
        <div className="auth-main">{children}</div>
        <AuthArt />
      </div>
      <Spacer />
      <div className="auth-fill" aria-hidden="true" />
      <Rule />
      <footer className="auth-bottom">
        <Icon name="lock" size={14} />
        <span>Self-hosted. Your data stays on this server.</span>
      </footer>
    </main>
  );
}
