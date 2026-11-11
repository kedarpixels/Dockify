import { Empty } from "@/components/ui/empty";
import { NotFound } from "@/components/ui/not-found";
import { Rule, Spacer } from "@/components/ui/rule";
import { StatusFoot, StatusTop } from "./frame";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StatusTop />
      <Rule />
      <div className="stp-fill" aria-hidden="true" />
      <Spacer />
      {children}
      <Spacer />
      <div className="stp-fill" aria-hidden="true" />
      <Rule />
      <StatusFoot />
    </>
  );
}

/** 404: no such project, or it has not published a status page. The two read the same. */
export function StatusMissing() {
  return (
    <Frame>
      <NotFound frame="public" title="No status page here" body="This project has not published a status page, or the link is wrong." />
    </Frame>
  );
}

/** The API could not be reached. Says nothing about whether the project exists. */
export function StatusUnavailable() {
  return (
    <Frame>
      <section className="stp-msg">
        <Empty as="h1" icon="alert" title="Status is unavailable right now" body="We could not load this status page. Try again in a minute." />
      </section>
    </Frame>
  );
}
