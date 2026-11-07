import type { Metadata } from "next";
import { StatusMissing } from "@/components/status-page/status-missing";

export const metadata: Metadata = {
  title: "Status page not found",
  robots: { index: false },
};

/* An unknown project and an unpublished page read the same, so slugs cannot be probed. */
export default function StatusNotFound() {
  return <StatusMissing />;
}
