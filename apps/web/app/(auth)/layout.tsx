import { AuthArt } from "@/components/auth/auth-art";
import { Icon } from "@/components/icon";
import { Rule, Spacer } from "@/components/ui/rule";
import { ThemeSwitch } from "@/components/ui/theme-switch";

/* Pages render their blocks (`.auth-block`, `<Rule />`) into the form cell, so every rule meets the rail on a node. */
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
