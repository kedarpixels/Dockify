import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SetupView } from "@/components/auth/setup-view";
import { Empty } from "@/components/ui/empty";
import { isSslipHost } from "@/lib/dashboard-domain";
import { SESSION_COOKIES } from "@/lib/forwarded";
import { getSetupStatus } from "@/lib/pages/auth-loaders";

export const metadata: Metadata = { title: "Set up" };

/** Once an admin exists this hands over to /login, except for the browser that just made it: creating the
 *  admin sets the session cookie, which re-renders this page mid-flow. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const status = await getSetupStatus();
  const jar = await cookies();
  // The design preview walks the connect step; ?email=on shows an install the installer set email up on.
  const previewEmailOn = status.source === "preview" && (await searchParams).email === "on";

  if (!status.data) {
    return (
      <section className="auth-block auth-block-empty">
        <Empty
          as="h1"
          icon="server"
          title={status.source === "none" ? "No data source" : "Cannot reach the Dockify API"}
          body={
            status.source === "none"
              ? "Set DOCKIFY_API_URL for this dashboard, then reload this page to create the first admin account."
              : "Setup needs the API to check whether an admin exists. Reload once it is running again."
          }
        />
      </section>
    );
  }
  if (!status.data.needsSetup && !SESSION_COOKIES.some((name) => !!jar.get(name)?.value)) redirect("/login");

  const preview = status.source === "preview";
  // The address the visitor came in on: the offer of a domain is for an install still on its sslip.io name.
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(":")[0] ?? "";
  return <SetupView finished={!status.data.needsSetup} suggestedName={status.data.instanceName} emailEnabled={preview ? previewEmailOn : status.data.emailEnabled} offerDomain={preview || isSslipHost(host)} preview={preview} />;
}
