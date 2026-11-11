import { IconsProvider } from "@/components/icons/app-icon";
import { SecurityReleaseProvider } from "@/components/shell/security-release";
import { Shell, type ShellData } from "@/components/shell/shell";
import { SessionExpired } from "@/components/ui/session-expired";
import { getOverview } from "@/lib/data";
import { buildShell } from "@/lib/derive";
import { getIcons } from "@/lib/pages/icons";
import { getSecurityAlert } from "@/lib/pages/security-release";
import { TimePrefsProvider } from "@/lib/time-prefs";
import { ViewerProvider } from "@/lib/viewer";

/* The overview and the icon map are read here once per load and again on router.refresh; between
   the two the shell follows the overview the page polls (lib/live-overview.ts).
   `modal` is the parallel slot that intercepted routes (the new project popup) render into. The
   viewer (who is signed in, and so which keys a Viewer may not use) reaches every console view. The
   security release provider sits inside it: every member gets the banner under the top bar, Admins
   the popup (components/shell/security-release.tsx). */
export default async function ConsoleLayout({ children, modal }: { children: React.ReactNode; modal?: React.ReactNode }) {
  const [{ data, source, fetchedAt }, icons, security] = await Promise.all([getOverview(), getIcons(), getSecurityAlert()]);
  const shell: ShellData = { ...buildShell(data), preview: source === "preview" };
  return (
    <IconsProvider icons={icons}>
      <TimePrefsProvider value={data?.viewer?.time}>
        <ViewerProvider viewer={data?.viewer ?? null}>
          <SecurityReleaseProvider initial={security}>
            <Shell data={shell} servedAt={fetchedAt}>{children}</Shell>
            {modal}
          </SecurityReleaseProvider>
          <SessionExpired />
        </ViewerProvider>
      </TimePrefsProvider>
    </IconsProvider>
  );
}
