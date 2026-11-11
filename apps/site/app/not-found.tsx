import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { Spacer } from "@/components/ui/rule";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main id="main" className="page">
      <Spacer />
      <section className="nf">
        <h1 className="sr">Page not found</h1>
        <p className="nf-code pixel" aria-hidden="true">
          404
        </p>
        <p className="nf-title">Lost the trail</p>
        <p className="nf-text">This page does not exist, or it moved. The docs and the install guide are right where you left them.</p>
        <div className="nf-actions">
          <Link href="/" className="btn btn-primary">
            <Icon name="arrowLeft" size={16} />
            Back to home
          </Link>
          <Link href="/docs" className="btn">
            Read the docs
          </Link>
        </div>
      </section>
      <Spacer end />
    </main>
  );
}
