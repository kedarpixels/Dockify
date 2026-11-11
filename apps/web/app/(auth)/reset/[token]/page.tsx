import type { Metadata } from "next";
import Link from "next/link";
import { ResetView } from "@/components/auth/reset-view";
import { Icon, type IconName } from "@/components/icon";
import { Empty } from "@/components/ui/empty";
import type { ResetResult } from "@/lib/pages/auth";
import { getReset } from "@/lib/pages/auth-loaders";

export const metadata: Metadata = { title: "Reset password", referrer: "no-referrer" };

const DEAD: Record<NonNullable<ResetResult["reason"]>, { icon: IconName; title: string; body: string }> = {
  invalid: {
    icon: "link",
    title: "This reset link is not valid",
    body: "Check that the whole link was copied from the email, or ask for a new one.",
  },
  expired: {
    icon: "clock",
    title: "This reset link has expired",
    body: "Reset links work for 30 minutes. Ask for a new one; your password has not changed.",
  },
  used: {
    icon: "checkCircle",
    title: "This reset link was already used",
    body: "Each link works once. If you set a new password with it, sign in with that password.",
  },
  unreachable: {
    icon: "server",
    title: "Cannot reach the Dockify API",
    body: "The link cannot be checked right now. Reload once the API is running again.",
  },
};

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await getReset(token);

  if (!result.data) {
    const reason = result.reason ?? "invalid";
    const dead = DEAD[reason];
    return (
      <section className="auth-block auth-block-empty">
        <Empty as="h1" icon={dead.icon} title={dead.title} body={dead.body} />
        {reason === "used" ? (
          <Link href="/login" className="btn btn-primary auth-submit">
            <Icon name="lockOpen" />
            Go to sign in
          </Link>
        ) : (
          <Link href="/forgot" className="btn auth-submit">
            Send a new link
          </Link>
        )}
      </section>
    );
  }

  return <ResetView token={token} reset={result.data} />;
}
