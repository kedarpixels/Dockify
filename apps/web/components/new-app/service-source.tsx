"use client";

import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ChoiceCards, type CardOption } from "./choice";
import type { ServiceDraft } from "./draft";
import { SERVICE_LABEL, SERVICE_VERSIONS, type ServiceKind } from "./spec";

/* Step 2 for a managed service: which one, and its version. Every one is private to the project,
   keeps its data on its own volume and gets a generated password. Storage is not offered: MinIO no
   longer publishes an image Dockify can run. */

const SERVICES: CardOption<ServiceKind>[] = [
  { value: "postgres", icon: "database", title: "Postgres", body: "Backups on a schedule, to this server or your storage, and restore into a new database." },
  { value: "redis", icon: "bolt", title: "Redis", body: "A cache or queue, password protected, saved to its own volume." },
];

/** How an app reaches it: a linked variable resolves to the credentials at deploy time. */
const NOTES: Record<ServiceKind, string> = {
  postgres: "Deploy it once it is created. On the next step, pick the apps that get DATABASE_URL; Dockify fills in the credentials at deploy time.",
  redis: "Deploy it once it is created. On the next step, pick the apps that get REDIS_URL; Dockify fills in the password at deploy time.",
};

export function ServiceSource({ draft, set }: { draft: ServiceDraft; set: (fn: (d: ServiceDraft) => ServiceDraft) => void }) {
  const versions = SERVICE_VERSIONS[draft.service];
  return (
    <div className="na-stack">
      <ChoiceCards
        label="Service"
        layout="stack"
        options={SERVICES}
        value={draft.service}
        onChange={(service) => set(() => ({ service, version: SERVICE_VERSIONS[service][0]! }))}
      />
      <div className="na-pair">
        <Field label="Version" hint="The first deploy pins the exact image; redeploys keep it.">
          {(ids) => (
            <Select
              ids={ids}
              label={`${SERVICE_LABEL[draft.service]} version`}
              className="na-sel"
              value={draft.version}
              onChange={(version) => set((d) => ({ ...d, version }))}
              options={versions.map((v, i) => ({ value: v, label: `${SERVICE_LABEL[draft.service]} ${v}`, hint: i === 0 ? "Latest" : undefined }))}
            />
          )}
        </Field>
      </div>
      <p className="fld-note">{NOTES[draft.service]} No port is published on the server.</p>
    </div>
  );
}
