"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { AddDomainDialog } from "@/components/resources-domains/add-domain-dialog";
import { useCloudflareDomains } from "@/components/resources-domains/cloudflare";
import { DomainHead, DomainRow as DomainLine } from "@/components/resources-domains/shared";
import { Empty } from "@/components/ui/empty";
import { PendingButton } from "@/components/ui/pending";
import { SkelRows } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { domainTargets } from "@/lib/domain-targets";
import { describe, errText } from "@/lib/feedback";
import { appTitle, plural } from "@/lib/format";
import type { AppDetail } from "@/lib/pages/project-detail";
import type { DomainRow, DomainsPayload } from "@/lib/pages/resources-domains";
import { useCan } from "@/lib/viewer";
import { TabCard, TabFailed } from "./states";
import { useAppTab } from "./use-tab";
import { notRunning } from "@/lib/derive";

/* Domains: this app's hostnames in the same rows as /domains, with their certificate, DNS and the
   record a broken one needs. Adding one opens the same two step dialog as /domains; removal and
   the bulk recheck stay on that page. A Viewer reads the rows without their keys, as on /domains. */

export function DomainsTab({ app, now }: { app: AppDetail; now: number }) {
  const q = useAppTab<DomainsPayload>(app.id, "domains");
  const can = useCan();
  const cf = useCloudflareDomains(can.manage && !!q.data && q.source !== "preview");
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const preview = q.source === "preview";
  const items = q.data?.items ?? [];
  // Where a domain's records should point. The tab gets the API's payload as it is (null for an unknown target).
  const target = useMemo(() => domainTargets(q.data), [q.data]);
  const where = `${app.projectSlug} / ${appTitle(app)}`;

  const check = async (d: DomainRow) => {
    if (checking.has(d.id)) return;
    setChecking((s) => new Set(s).add(d.id));
    try {
      if (!preview) {
        const r = await callJson<DomainRow>(`/api/domains/${encodeURIComponent(d.id)}/check`, { method: "POST" });
        if (!r.ok) throw new Error(r.error);
        const row = r.data;
        if (!row?.id) throw new Error("The API sent no domain");
        q.patch((p) => ({ ...p, items: p.items.map((x) => (x.id === row.id ? row : x)) }));
        const ok = row.dns.status === "ok";
        toast[ok ? "success" : "warn"](ok ? "The domain points here" : "The domain does not point here", { description: d.hostname });
      } else {
        toast.success("DNS checked", { description: describe([d.hostname], { preview }) });
      }
    } catch (e) {
      toast.error("Could not check DNS", { description: describe([d.hostname, errText(e, "The API did not answer")]) });
    } finally {
      setChecking((s) => {
        const next = new Set(s);
        next.delete(d.id);
        return next;
      });
    }
  };

  const added = (d: DomainRow, recordMade?: boolean) => {
    q.patch((p) => ({ ...p, items: [...p.items, d] }));
    setAdding(false);
    toast.success("Domain added", { description: describe([recordMade ? `${d.hostname} on ${where}` : `${d.hostname} on ${where}, create its DNS record next`], { preview }) });
  };

  return (
    <TabCard
      id="at-dom-title"
      icon="globe"
      title="Domains"
      sub={q.data ? `${plural(items.length, "domain")} on ${where}` : "Hostnames that reach this app"}
      actions={
        <>
          <Link href="/domains" className="btn btn-sm">
            View all domains
          </Link>
          {can.manage ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={!q.data} onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Add domain
            </button>
          ) : null}
        </>
      }
    >
      {!q.data && q.loading ? (
        <div className="rd-list">
          <SkelRows rows={2} height={56} template="minmax(0, 1.6fr) 168px 136px minmax(0, 1fr) 68px" cols={[{ w: "60%", lines: 2 }, 72, { w: "70%", lines: 2 }, { w: "50%", lines: 2 }, 32]} />
        </div>
      ) : !q.data ? (
        <TabFailed error={q.error} onRetry={q.reload} what="Domains for this app" />
      ) : items.length === 0 ? (
        <Empty
          icon="globe"
          title="No domains yet"
          body={
            !can.manage
              ? "Hostnames show up here once an admin adds them."
              : notRunning(app.status)
                ? `Add a hostname now; it serves once ${appTitle(app)} runs.`
                : "Add a hostname, point its DNS at this server, and Dockify issues the certificate."
          }
        />
      ) : (
        <div className="rd-list">
          <DomainHead />
          <ul className="dm-rows" aria-label="Domains">
            {items.map((d, i) => {
              const busy = checking.has(d.id);
              return (
                <DomainLine
                  key={d.id}
                  d={d}
                  now={now}
                  target={target}
                  checking={busy}
                  delay={Math.min(i, 12) * 30}
                  actions={
                    can.manage ? (
                      <PendingButton
                        className="btn btn-sm btn-icon"
                        aria-label={`Recheck DNS for ${d.hostname}`}
                        data-tip={busy ? "Checking" : "Recheck DNS"}
                        data-tip-align="end"
                        pending={busy}
                        icon="refresh"
                        onClick={() => void check(d)}
                      />
                    ) : null
                  }
                />
              );
            })}
          </ul>
        </div>
      )}
      {adding && q.data ? (
        <AddDomainDialog targets={[app]} existing={items} target={target} live={!preview} cloudflare={cf.data?.connected === true} onClose={() => setAdding(false)} onAdded={added} />
      ) : null}
    </TabCard>
  );
}
