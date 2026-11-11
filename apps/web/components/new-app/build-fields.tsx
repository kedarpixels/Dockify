"use client";

import { Optional } from "@/components/project-detail/shared";
import { Field, TextInput } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { Skel } from "@/components/ui/skeleton";
import type { BuildDraft, Detect, Errors } from "./draft";

/* A blank command means whatever is detected at each deploy, so fields show the detection as a placeholder and never freeze it. */

export const START_COMMAND_HINT = "Runs in place of the image’s entrypoint; flags go to it instead. Quotes, variables or && need a shell in the image. Blank runs the image as built.";

function Detected({ detect, onRetry }: { detect: Detect; onRetry: () => void }) {
  if (detect.state === "idle") return null;
  if (detect.state === "loading") {
    return (
      <p className="na-detect" role="status" aria-label="Reading the repository">
        <Skel w={140} />
        <span className="na-detect-sub">Reading the repository</span>
      </p>
    );
  }
  if (detect.state === "error") {
    return (
      <p className="na-detect" data-tone="warn">
        <span className="na-detect-main">Could not read the repository</span>
        <span className="na-detect-sub">{detect.error}</span>
        <button type="button" className="btn btn-xs" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  const r = detect.result;
  if (!r.detected) {
    return (
      <p className="na-detect" data-tone="warn">
        <span className="na-detect-main">Nothing recognised</span>
        <span className="na-detect-sub">{r.reason ?? "Add a Dockerfile, or set the commands below."}</span>
      </p>
    );
  }
  return (
    <p className="na-detect">
      <span className="na-detect-main">{r.framework ?? "Dockerfile"} detected</span>
      <span className="na-detect-sub">{r.hasDockerfile ? "This repository has a Dockerfile" : r.staticSite ? "Built with Railpack and served as static files" : "Built with Railpack, no Dockerfile needed"}</span>
    </p>
  );
}

export function BuildFields({ value, onChange, errors, detect, onRetry }: { value: BuildDraft; onChange: (patch: Partial<BuildDraft>) => void; errors: Errors; detect: Detect; onRetry: () => void }) {
  const found = detect.state === "done" ? detect.result : null;
  // Auto with a Dockerfile in the repository builds from it, so the choice reads that way too.
  const usesDockerfile = value.builder === "dockerfile" || (value.builder === "auto" && !!found?.hasDockerfile);
  return (
    <fieldset className="na-group">
      <legend className="na-legend">Build</legend>
      <Detected detect={detect} onRetry={onRetry} />
      {found?.hasDockerfile ? (
        <Field label="Build with">
          {() => (
            <Segmented
              label="Build with"
              value={usesDockerfile ? "dockerfile" : "railpack"}
              onChange={(builder) => onChange({ builder, dockerfilePath: builder === "dockerfile" ? value.dockerfilePath || found?.dockerfilePath || "Dockerfile" : "" })}
              options={[
                { value: "dockerfile", label: "Dockerfile" },
                { value: "railpack", label: "Railpack" },
              ]}
            />
          )}
        </Field>
      ) : null}
      {usesDockerfile ? (
        <Field label="Dockerfile path" error={errors.dockerfilePath} hint="Relative to the root directory.">
          {(ids) => <CommandInput ids={ids} placeholder="Dockerfile" value={value.dockerfilePath} onChange={(dockerfilePath) => onChange({ dockerfilePath })} />}
        </Field>
      ) : (
        <div className="na-pair">
          <Field label={<Optional>Install command</Optional>} error={errors.installCommand} hint="Blank uses what is detected.">
            {(ids) => <CommandInput ids={ids} placeholder={found?.installCommand || "npm ci"} value={value.installCommand} onChange={(installCommand) => onChange({ installCommand })} />}
          </Field>
          <Field label={<Optional>Build command</Optional>} error={errors.buildCommand} hint="Blank uses what is detected.">
            {(ids) => <CommandInput ids={ids} placeholder={found?.buildCommand || "npm run build"} value={value.buildCommand} onChange={(buildCommand) => onChange({ buildCommand })} />}
          </Field>
        </div>
      )}
      <div className="na-pair">
        <Field label={<Optional>Start command</Optional>} error={errors.startCommand} hint={usesDockerfile ? START_COMMAND_HINT : "Blank uses what is detected."}>
          {(ids) => <CommandInput ids={ids} placeholder={(!usesDockerfile && found?.startCommand) || "node server.js"} value={value.startCommand} onChange={(startCommand) => onChange({ startCommand })} />}
        </Field>
        <PortField value={value.port} onChange={(port) => onChange({ port })} error={errors.port} hint={usesDockerfile ? undefined : "Where the app listens, also passed as PORT. Blank with a domain uses what the build detects."} />
      </div>
    </fieldset>
  );
}

function CommandInput({ ids, placeholder, value, onChange }: { ids: Parameters<typeof TextInput>[0]["ids"]; placeholder: string; value: string; onChange: (v: string) => void }) {
  return <TextInput ids={ids} className="mono" autoComplete="off" spellCheck={false} placeholder={placeholder} title={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />;
}

export function PortField({ value, onChange, error, hint = "Where the app listens. Blank with a domain uses what the image exposes." }: { value: string; onChange: (v: string) => void; error?: string; hint?: string }) {
  return (
    <Field label={<Optional>Port</Optional>} error={error} hint={hint}>
      {(ids) => (
        <TextInput
          ids={ids}
          className="num"
          inputMode="numeric"
          autoComplete="off"
          placeholder="3000"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, "").slice(0, 5))}
        />
      )}
    </Field>
  );
}
