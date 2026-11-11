"use client";

import { useCallback, useEffect, useState } from "react";
import { gitFetch, useInstallations } from "@/components/git/client";
import { PickedRepo, UrlImport, type Picked } from "@/components/git/import-parts";
import { clause } from "@/lib/format";
import { RepoPicker } from "@/components/git/repo-picker";
import { Optional } from "@/components/project-detail/shared";
import { Field, TextInput } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { GitBranch } from "@/lib/pages/git";
import { BuildFields } from "./build-fields";
import { detect } from "./client";
import { pickUrl, repoPicked, repoUrlOf, type BuildDraft, type Errors, type GitDraft } from "./draft";
import type { DetectResult } from "./spec";

/* Nothing here depends on the repository read finishing: a deploy works it out again. */

type Set = (fn: (d: GitDraft) => GitDraft) => void;

/** Waits for typing in the branch and folder fields to stop before starting a clone. */
const SETTLE_MS = 700;
const POLL_MS = 2_000;
/** The worker's own limits end a read well before this; past it the page stops asking. */
const GIVE_UP_MS = 7 * 60_000;

/** An edited field or a typed port always stays. */
export function applyDetected(d: GitDraft, r: DetectResult): GitDraft {
  const port = d.build.port || (r.port === null ? "" : String(r.port));
  const next = { ...d, detect: { state: "done" as const, result: r } };
  if (d.edited) return { ...next, build: { ...d.build, framework: r.framework } };
  return { ...next, build: { ...d.build, framework: r.framework, port, builder: r.hasDockerfile ? "dockerfile" : "railpack", dockerfilePath: r.hasDockerfile ? r.dockerfilePath : "" } };
}

export function GitSource({ draft, set, errors }: { draft: GitDraft; set: Set; errors: Errors }) {
  const [installations, reload] = useInstallations();
  const list = installations.state === "ready" ? installations.list : [];
  const account = list.some((i) => i.id === draft.account) ? draft.account : (list[0]?.id ?? null);

  const { picked, branch, rootDir } = draft;

  const onBranch = useCallback((b: string) => set((d) => (d.branch === b ? d : { ...d, branch: b })), [set]);
  const onBuild = (patch: Partial<BuildDraft>) => set((d) => ({ ...d, build: { ...d.build, ...patch }, edited: true }));

  const [attempt, setAttempt] = useState(0);
  const repoUrl = picked ? repoUrlOf(picked) : null;
  const gitRef = picked?.kind === "git" ? picked.installation.id : null;
  const repoId = picked?.kind === "git" ? picked.repo.id : null;
  useEffect(() => {
    if (!repoUrl || !branch.trim()) return;
    // What an earlier branch or folder read says nothing about this one, and Continue must wait for it.
    set((d) => (d.detect.state === "idle" ? d : { ...d, detect: { state: "idle" } }));
    const ctl = new AbortController();
    const input = { repoUrl, branch: branch.trim(), rootDir: rootDir.replace(/\/+$/, ""), ...(gitRef && repoId ? { git: { installationId: gitRef, repoId } } : {}) };
    const startedAt = Date.now();
    const ask = async (): Promise<void> => {
      const r = await detect(input, ctl.signal);
      if (ctl.signal.aborted) return;
      if (!r.ok) return set((d) => ({ ...d, detect: { state: "error", error: r.error } }));
      const answer = r.data;
      if (!answer) return set((d) => ({ ...d, detect: { state: "error", error: "The answer could not be read" } }));
      if (!answer.pending) return set((d) => applyDetected(d, answer));
      if (Date.now() - startedAt > GIVE_UP_MS) return set((d) => ({ ...d, detect: { state: "error", error: "This is taking too long. The deploy will work it out." } }));
      await new Promise((go) => setTimeout(go, POLL_MS));
      if (!ctl.signal.aborted) return ask();
    };
    const timer = setTimeout(() => {
      set((d) => ({ ...d, detect: { state: "loading" } }));
      void ask();
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [repoUrl, gitRef, repoId, branch, rootDir, attempt, set]);

  if (!picked) {
    // The URL view keeps no key of its own: the dialog footer Continue (and Enter) picks the URL.
    return draft.byUrl ? (
      <UrlImport
        value={draft.url}
        tried={draft.urlTried}
        onChange={(url) => set((d) => ({ ...d, url }))}
        onSubmit={() => set(pickUrl)}
        onBack={() => set((d) => ({ ...d, byUrl: false, urlTried: false }))}
      />
    ) : (
      <RepoPicker
        installations={installations}
        reload={() => void reload()}
        account={account}
        onAccount={(id) => set((d) => ({ ...d, account: id }))}
        onPick={(installation, repo) => set((d) => repoPicked({ ...d, account: installation.id }, { kind: "git", installation, repo }, repo.defaultBranch))}
        onUseUrl={() => set((d) => ({ ...d, byUrl: true }))}
      />
    );
  }

  return (
    <div className="na-stack">
      <PickedRepo picked={picked} onChange={() => set((d) => ({ ...d, picked: null }))} />
      <div className="na-pair">
        <BranchField picked={picked} value={branch} onChange={onBranch} error={errors.branch} />
        <Field label={<Optional>Root directory</Optional>} error={errors.rootDir} hint="For a monorepo, the app’s folder.">
          {(ids) => (
            <TextInput
              ids={ids}
              className="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="apps/web"
              value={rootDir}
              onChange={(e) => set((d) => ({ ...d, rootDir: e.target.value.trim() }))}
            />
          )}
        </Field>
      </div>
      <BuildFields value={draft.build} onChange={onBuild} errors={errors} detect={draft.detect} onRetry={() => setAttempt((n) => n + 1)} />
    </div>
  );
}

type Branches = { state: "loading" } | { state: "ready"; list: GitBranch[] } | { state: "error"; error: string };

/** A URL import, or a list that failed to load, types the name instead. */
function BranchField({ picked, value, onChange, error }: { picked: Picked; value: string; onChange: (b: string) => void; error?: string }) {
  const repoId = picked.kind === "git" ? picked.repo.id : null;
  const [branches, setBranches] = useState<Branches>({ state: "loading" });

  // Another repository starts over on "Loading branches", from the render that picks it.
  const [listed, setListed] = useState(repoId);
  if (repoId !== listed) {
    setListed(repoId);
    setBranches({ state: "loading" });
  }

  useEffect(() => {
    if (!repoId) return;
    const ctl = new AbortController();
    void gitFetch<GitBranch[]>(`/repos/${encodeURIComponent(repoId)}/branches`, { signal: ctl.signal }).then((r) => {
      if (!ctl.signal.aborted) setBranches(r.ok ? { state: "ready", list: r.data } : { state: "error", error: r.error });
    });
    return () => ctl.abort();
  }, [repoId]);

  // A list without the current pick moves the pick to the default branch.
  useEffect(() => {
    if (branches.state !== "ready" || !branches.list.length || branches.list.some((b) => b.name === value)) return;
    onChange((branches.list.find((b) => b.default) ?? branches.list[0]!).name);
  }, [branches, value, onChange]);

  const pickable = repoId && branches.state !== "error";
  const hint = branches.state === "error" && repoId ? `Could not list branches, ${clause(branches.error)}. Type the name.` : "Pushes to this branch deploy the app.";
  return (
    <Field label="Branch" error={error} hint={hint}>
      {(ids) =>
        pickable ? (
          <Select
            ids={ids}
            label="Branch"
            icon="branch"
            className="na-sel"
            value={branches.state === "ready" ? value : null}
            placeholder="Loading branches"
            disabled={branches.state === "loading"}
            onChange={onChange}
            options={branches.state === "ready" ? branches.list.map((b) => ({ value: b.name, label: b.name, hint: b.default ? "Default" : undefined })) : []}
          />
        ) : (
          <TextInput ids={ids} className="mono" autoComplete="off" spellCheck={false} placeholder="main" value={value} onChange={(e) => onChange(e.target.value.trim())} />
        )
      }
    </Field>
  );
}
