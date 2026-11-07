import { Spacer } from "@/components/ui/rule";
import { PageHead } from "@/components/site/page-head";
import { CompareTable, WhySwitch } from "@/components/pages/compare";
import { Closer } from "@/components/pages/closer";
import { pageMetadata } from "@/components/seo/metadata";

export const metadata = pageMetadata({
  path: "/compare",
  title: "Compare",
  description: "Dockify next to Coolify, Dokploy and Vercel, with a source for every competitor cell. Where the others win, we say so.",
});

export default function Page() {
  return (
    <main id="main" className="page">
      <Spacer />
      <PageHead
        eyebrow="Compare"
        title="Dockify, Coolify, Dokploy and Vercel"
        lead="We built Dockify for one job, so it does less than the others. Here is the honest picture. Every competitor cell links its source."
      />
      <CompareTable />
      <Spacer />
      <WhySwitch />
      <Spacer />
      <Closer
        title="Pick Dockify if everything you run fits on one server and you want it to stay up."
        primary={{ href: "/install", label: "Install on your server", icon: "terminal" }}
        secondary={{ href: "/docs", label: "Read the docs" }}
      />
      <Spacer end />
    </main>
  );
}
