"use client";

import Link from "next/link";
import { clause } from "@/lib/format";
import { Optional } from "@/components/project-detail/shared";
import { Field, TextInput } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { PortField, START_COMMAND_HINT } from "./build-fields";
import type { ContextState } from "./client";
import type { Errors, ImageDraft } from "./draft";

/*
 * Step 2 for a Docker image: the reference, the registry credentials to pull it with (picked
 * from Settings, Integrations, and matched to the image’s host until the operator picks one),
 * and an optional command and port.
 */

const PUBLIC = "__public";

/** The registry host an image reference names: ghcr.io/a/b is ghcr.io, nginx is docker.io. */
function registryHost(ref: string) {
  const first = ref.trim().split("/")[0] ?? "";
  return ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first.split(":")[0]! : "docker.io";
}

export function ImageSource({ draft, set, errors, ctx }: { draft: ImageDraft; set: (fn: (d: ImageDraft) => ImageDraft) => void; errors: Errors; ctx: ContextState }) {
  const registries = ctx.state === "ready" ? ctx.data.registries : [];

  const onImage = (image: string) =>
    set((d) => {
      if (d.registryPicked) return { ...d, image };
      // Until the operator picks, the registry follows the image's host.
      const match = registries.find((r) => r.host === registryHost(image));
      return { ...d, image, registryId: match?.id ?? null };
    });

  const picked = registries.find((r) => r.id === draft.registryId);
  const hint =
    ctx.state === "error" ? (
      `Could not load registries, ${clause(ctx.error)}. Public images still work.`
    ) : picked?.error ? (
      <span className="tone-warn">{clause(picked.error)}. Update it in Settings, Integrations.</span>
    ) : (
      <>
        Credentials come from <Link href="/settings?section=integrations">Settings, Integrations</Link>.
      </>
    );

  return (
    <div className="na-stack">
      <Field label="Image" error={errors.image} hint="A tag or a digest. Without a tag, Dockify pins the current latest.">
        {(ids) => (
          <TextInput
            ids={ids}
            data-autofocus
            autoFocus
            className="mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="ghcr.io/owner/app:1.0"
            value={draft.image}
            onChange={(e) => onImage(e.target.value.trim())}
          />
        )}
      </Field>
      <Field label="Registry" hint={hint}>
        {(ids) => (
          <Select
            ids={ids}
            label="Registry"
            className="na-sel"
            disabled={ctx.state === "loading"}
            placeholder="Loading registries"
            value={ctx.state === "loading" ? null : (draft.registryId ?? PUBLIC)}
            onChange={(v) => set((d) => ({ ...d, registryId: v === PUBLIC ? null : v, registryPicked: true }))}
            options={[
              { value: PUBLIC, label: "Public image", hint: "No credentials", icon: "globe" as const },
              ...registries.map((r) => ({ value: r.id, label: r.host, hint: r.username, icon: "key" as const, tone: r.error ? ("warn" as const) : undefined })),
            ]}
          />
        )}
      </Field>
      <div className="na-pair">
        <Field label={<Optional>Start command</Optional>} error={errors.startCommand} hint={START_COMMAND_HINT}>
          {(ids) => (
            <TextInput
              ids={ids}
              className="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="node server.js"
              value={draft.startCommand}
              onChange={(e) => set((d) => ({ ...d, startCommand: e.target.value }))}
            />
          )}
        </Field>
        <PortField value={draft.port} onChange={(port) => set((d) => ({ ...d, port }))} error={errors.port} />
      </div>
    </div>
  );
}
