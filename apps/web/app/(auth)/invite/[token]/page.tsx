import type { Metadata } from "next";
import Link from "next/link";
import { InviteView } from "@/components/auth/invite-view";
import { Icon, type IconName } from "@/components/icon";
import { Empty } from "@/components/ui/empty";
import type { InviteResult } from "@/lib/pages/auth";
import { getInvite } from "@/lib/pages/auth-loaders";

export const metadata: Metadata = { title: "Accept invite" };

/* "today", "tomorrow" or "in 5 days", worked out on the server so both renders agree. */
function expiresIn(iso: string) {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

const DEAD: Record<NonNullable<InviteResult["reason"]>, { icon: IconName; title: string; body: string }> = {
  invalid: {
    icon: "link",
    title: "This invite link is not valid",
    body: "Check that the whole link was copied, or ask the person who invited you for a new one.",
  },
  expired: {
    icon: "clock",
    title: "This invite has expired",
    body: "Invite links work for a limited time. Ask the person who invited you to send a new one from Settings.",
  },
  used: {
    icon: "checkCircle",
    title: "This invite was already used",
    body: "Each invite link works once. If that was you, sign in with the account you made.",
  },
  unreachable: {
    icon: "server",
    title: "Cannot reach the Dockify API",
    body: "The invite cannot be checked right now. Reload once the API is running again.",
  },
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await getInvite(token);

  const reason = result.reason ?? "invalid";
  const dead = DEAD[reason];
  // Always the same component here, so the refresh after accepting keeps its state (see InviteView).
  return (
    <InviteView
      token={token}
      invite={result.data ?? null}
      expires={result.data ? expiresIn(result.data.expiresAt) : ""}
      gone={
        <section className="auth-block auth-block-empty">
          <Empty as="h1" icon={dead.icon} title={dead.title} body={dead.body} />
          {/* A used invite most likely means an account exists, so sign in is the way forward. */}
          <Link href="/login" className={reason === "used" ? "btn btn-primary auth-submit" : "btn auth-submit"}>
            {reason === "used" ? <Icon name="lockOpen" /> : null}
            Go to sign in
          </Link>
        </section>
      }
    />
  );
}
