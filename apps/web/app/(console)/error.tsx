"use client";

import { Topbar } from "@/components/shell/topbar";
import { Empty } from "@/components/ui/empty";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";

export default function ConsoleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <Topbar trail={["Error"]} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead level={1} title="Something went wrong" lead="This page hit an error while loading. The rest of the dashboard still works." />
        <Rule />
        <div className="card">
          <Empty
            icon="alert"
            title="Could not show this page"
            body={`Try again. If it keeps failing, the web container logs say why${error.digest ? `, under reference ${error.digest}` : ""}.`}
            action={
              <button type="button" className="btn btn-sm" onClick={reset}>
                Try again
              </button>
            }
          />
        </div>
        <Spacer end />
      </main>
    </>
  );
}
