"use client";

import { useEffect, useMemo, useState } from "react";
import { Callout } from "@/components/ui/callout";
import type { IconName } from "@/components/icon";
import type { IntegrationsConnected, IntegrationsResult } from "@/lib/pages/integrations";
import type { Overview } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { Group } from "../form";
import { IntegrationCard } from "./card";
import { CloudflareCard } from "./cloudflare-card";
import { EmailCard } from "./email-card";
import { GithubCard } from "./github-card";
import { RegistriesCard } from "./registries-card";
import { StorageCard } from "./storage-card";
import { VercelCard } from "./vercel-card";
import type { ImportTarget } from "./vercel-import";
import { WebhooksCard } from "./webhooks-card";
import { clause } from "@/lib/format";

/* Each card owns its slice of the loaded summary and keeps it current after its own writes, so nothing refetches the set. */

function importTargets(overview: Overview | null): ImportTarget[] {
  const map = new Map<string, Set<string>>();
  // A project with no apps yet starts on production.
  for (const p of overview?.projects ?? []) map.set(p.slug, new Set(["production"]));
  for (const r of overview?.resources ?? []) {
    const envs = map.get(r.projectSlug) ?? new Set<string>();
    envs.add(r.environment);
    map.set(r.projectSlug, envs);
  }
  return [...map]
    .map(([slug, envs]) => ({ slug, environments: [...envs].sort((a, b) => (a === "production" ? -1 : b === "production" ? 1 : a.localeCompare(b))) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** A Viewer's list, from the API's small answer. Details are an admin's. */
function ConnectedList({ connected }: { connected: IntegrationsConnected }) {
  const rows: Array<{ id: string; icon: IconName; name: string; purpose: string; on: boolean }> = [
    { id: "int-github", icon: "github", name: "GitHub", purpose: "Import repositories and deploy on every push.", on: connected.github },
    { id: "int-vercel", icon: "vercel", name: "Vercel", purpose: "See Vercel deployments and logs here, or move projects off Vercel.", on: connected.vercel },
    { id: "int-cloudflare", icon: "cloud", name: "Cloudflare", purpose: "Create DNS records and certificates automatically.", on: connected.cloudflare },
    { id: "int-registries", icon: "box", name: "Container registries", purpose: "Pull private images.", on: connected.registries },
    { id: "int-storage", icon: "archive", name: "Backup storage", purpose: "Where backups are stored.", on: connected.storage },
    { id: "int-webhooks", icon: "webhook", name: "Webhooks", purpose: "Send alerts and update notices to Discord, Slack, Teams and more.", on: connected.webhooks },
    { id: "int-email", icon: "mail", name: "Email", purpose: "Invites, resets, codes and alerts, through your own mail server.", on: connected.email },
  ];
  return (
    <Group id="set-integrations" icon="link" title="Integrations" sub="Services Dockify connects to on your behalf. Only an admin can see their details or change them">
      <ul className="int-rows">
        {rows.map((r) => (
          <IntegrationCard key={r.id} id={r.id} icon={r.icon} name={r.name} purpose={r.purpose} status={r.on ? "connected" : "disconnected"}>
            {null}
          </IntegrationCard>
        ))}
      </ul>
    </Group>
  );
}

export function IntegrationsSection({
  initial,
  overview,
  now,
  onEmail,
}: {
  initial: IntegrationsResult;
  overview: Overview | null;
  now: number;
  /** Tells the rest of Settings when email is connected or dropped (invites, email change). */
  onEmail?: (connected: boolean) => void;
}) {
  if (initial.data.connected) return <ConnectedList connected={initial.data.connected} />;
  return <AllIntegrations initial={initial} overview={overview} now={now} onEmail={onEmail} />;
}

function AllIntegrations({
  initial,
  overview,
  now,
  onEmail,
}: {
  initial: IntegrationsResult;
  overview: Overview | null;
  now: number;
  onEmail?: (connected: boolean) => void;
}) {
  const preview = initial.source === "preview";
  const [vercel, setVercel] = useState(initial.data.vercel);
  const [cloudflare, setCloudflare] = useState(initial.data.cloudflare);
  const [registries, setRegistries] = useState(initial.data.registries);
  const [storage, setStorage] = useState(initial.data.storage);
  const [webhooks, setWebhooks] = useState(initial.data.webhooks);
  const [email, setEmail] = useState(initial.data.email);
  const targets = useMemo(() => importTargets(overview), [overview]);
  const emailOn = email !== null;
  useEffect(() => onEmail?.(emailOn), [emailOn, onEmail]);
  const { manage } = useCan();

  return (
    <Group
      id="set-integrations"
      icon="link"
      title="Integrations"
      sub={manage ? "Services Dockify connects to on your behalf" : "Services Dockify connects to on your behalf. Only an admin can change them"}
    >
      {initial.error ? (
        <Callout tone="warn" icon="alert" role="status" className="int-load-note">
          {clause(initial.error)}. Each row shows what this page could load. Reload the page to try again.
        </Callout>
      ) : null}
      <ul className="int-rows">
        <GithubCard initialAccounts={initial.data.github.accounts} initialApp={initial.data.github.app} now={now} preview={preview} />
        <VercelCard value={vercel} onChange={setVercel} targets={targets} now={now} preview={preview} />
        <CloudflareCard value={cloudflare} onChange={setCloudflare} now={now} preview={preview} />
        <RegistriesCard value={registries} onChange={setRegistries} preview={preview} />
        <StorageCard value={storage} onChange={setStorage} now={now} preview={preview} />
        <WebhooksCard value={webhooks} onChange={setWebhooks} now={now} preview={preview} />
        <EmailCard value={email} onChange={setEmail} now={now} preview={preview} />
      </ul>
    </Group>
  );
}
