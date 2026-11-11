import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { Shell, type ShellData } from "@/components/shell/shell";
import { Topbar } from "@/components/shell/topbar";
import { NotFound as NotFoundBlock } from "@/components/ui/not-found";
import { Spacer } from "@/components/ui/rule";
import { getOverview } from "@/lib/data";
import { buildShell } from "@/lib/derive";

export const metadata: Metadata = {
  title: "Page not found",
};

export default async function NotFound() {
  const { data, source } = await getOverview();
  const shell: ShellData = { ...buildShell(data), preview: source === "preview" };

  return (
    <Shell data={shell}>
      <Topbar trail={["Not found"]} />
      <main className="page" id="main" tabIndex={-1}>
        <NotFoundBlock
          actions={
            <>
              <Link href="/" className="btn btn-primary">
                <Icon name="arrowLeft" />
                Back to overview
              </Link>
              <Link href="/projects" className="btn">
                Open projects
              </Link>
            </>
          }
        />
        <Spacer end />
      </main>
    </Shell>
  );
}
