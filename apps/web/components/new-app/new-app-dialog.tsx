"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { Dialog } from "@/components/ui/dialog";
import { envName } from "@/components/ui/env-tag";
import { showsEnvironments } from "@/lib/environments";
import { PendingButton } from "@/components/ui/pending";
import { report } from "@/lib/feedback";
import type { ProjectDetail } from "@/lib/pages/project-detail";
import { ActionCards, type CardOption } from "./choice";
import { parseRepo } from "@/components/git/parse";
import { createApps, useNewAppContext } from "./client";
import { planCompose } from "./compose";
import { ComposeSource } from "./compose-source";
import { useTestDomainOffer } from "@/components/resources-domains/test-domain";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { DetailsStep } from "./details-step";
import {
  composeErrors,
  composeSpecs,
  gitErrors,
  imageErrors,
  initialCompose,
  initialGit,
  initialImage,
  initialService,
  linkable,
  nameError,
  pickUrl,
  proposedKind,
  proposedName,
  singleSpec,
  sourceLine,
  type DetailsDraft,
  type Errors,
} from "./draft";
import { GitSource } from "./git-source";
import { waitsForRead } from "./read-wait";
import { ImageSource } from "./image-source";
import { ServiceSource } from "./service-source";
import { LINK_CONFLICT, LINK_KEY, LINKABLE_KINDS, listNames, type LinkConflict, type ServiceLink, type SourceType } from "./spec";
import { deployTemplate, useTemplates } from "./client";
import { TemplatePicker, TemplateReview } from "./template-source";
import { draftFor, initialTemplate, templateHostError, templateInputError, templateNameError, type TemplateRow } from "./template-spec";

// Every draft lives here so Back keeps what was typed; it mounts only while open, so each opening
// starts clean. Linking never replaces a variable silently: a conflict creates nothing and asks.

const SOURCES: CardOption<SourceType>[] = [
  { value: "git", icon: "github", title: "GitHub repository", body: "Build a branch, from its Dockerfile when it has one, otherwise detected and built for you." },
  { value: "image", icon: "box", title: "Docker image", body: "Run a public image, or a private one with credentials from a connected registry." },
  { value: "service", icon: "database", title: "Database or service", body: "Postgres or Redis, private to the project, on its own volume, with backups." },
  { value: "template", icon: "grid", title: "Templates", body: "Popular self-hosted apps, ready to deploy. See exactly what will run first." },
  { value: "compose", icon: "layers", title: "Compose import", body: "Paste a docker-compose.yml. Each service becomes an app you can review first." },
];

const TITLE = Object.fromEntries(SOURCES.map((s) => [s.value, s.title])) as Record<SourceType, string>;
const ICON = Object.fromEntries(SOURCES.map((s) => [s.value, s.icon])) as Record<SourceType, IconName>;

type Step = 1 | 2 | 3;

const hasErrors = (e: Errors) => Object.values(e).some(Boolean);

type Props = {
  p: ProjectDetail;
  open: boolean;
  onClose: () => void;
  /** Opens on step 2 with this source picked: "service" for Postgres or Redis. */
  start?: SourceType;
  /** The app New app was opened from: a new service starts in its environment, linked to it. */
  forApp?: string;
  environment?: string;
};

export function NewAppDialog(props: Props) {
  return props.open ? <NewAppFlow {...props} /> : null;
}

function NewAppFlow({ p, open, onClose, start, forApp, environment }: Props) {
  const router = useRouter();
  const ctx = useNewAppContext();
  const body = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>(start ? 2 : 1);
  const [source, setSource] = useState<SourceType | null>(start ?? null);
  const [git, setGit] = useState(initialGit);
  const [image, setImage] = useState(initialImage);
  const [service, setService] = useState(initialService);
  const [compose, setCompose] = useState(initialCompose);
  const [template, setTemplate] = useState(initialTemplate);
  const templates = useTemplates(source === "template");
  const [details, setDetails] = useState<DetailsDraft>(() => {
    const from = p.apps.find((a) => a.id === forApp && LINKABLE_KINDS.has(a.kind));
    return { name: "", named: false, environment: from?.environment ?? (p.environments.some((e) => e.name === environment) ? environment! : (p.environments[0]?.name ?? "production")), kind: null, target: "server", links: from ? [from.id] : [] };
  });
  const [conflict, setConflict] = useState<LinkConflict | null>(null);
  const [replace, setReplace] = useState<string[]>([]);
  const [tried, setTried] = useState<Step | 0>(0);
  const [busy, setBusy] = useState(false);
  // Off until asked for: each test domain is a certificate from Let's Encrypt.
  const offer = useTestDomainOffer();
  const [wantTestDomain, setWantTestDomain] = useState(false);

  // The Compose review follows the text 250ms after typing settles, so errors do not flicker.
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSettled(compose.text), 250);
    return () => clearTimeout(t);
  }, [compose.text]);
  const plan = useMemo(() => (settled.trim() ? planCompose(settled) : null), [settled]);

  // Each step starts on its first control. The first step's card gets it from the Dialog itself.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const el = body.current?.querySelector<HTMLElement>("[data-autofocus], input:not([type=checkbox]), textarea, [role=radio][tabindex='0'], button");
    el?.focus({ preventScroll: true });
  }, [step, source]);

  const taken = useMemo(() => new Set(p.apps.filter((a) => a.environment === details.environment).map((a) => a.name)), [p.apps, details.environment]);
  const name = details.named ? details.name : proposedName(source, git, image, service, taken);
  const kind = details.kind ?? proposedKind(source, git);
  const many = source === "compose" ? composeSpecs(compose, plan) : null;
  const clashes = many?.filter((a) => taken.has(a.name)).map((a) => a.name) ?? [];
  // A project with one environment names none, here as everywhere (lib/environments.ts).
  const multi = showsEnvironments(p.environments);
  const env = envName(details.environment);

  // The template flow has its own checks; these read "no errors" for it.
  const stepErrors: Errors =
    source === "git" ? gitErrors(git) : source === "image" ? imageErrors(image) : source === "compose" ? composeErrors(compose, plan) : {};
  const shown = tried >= 2 ? stepErrors : {};
  const nameErr = many ? undefined : nameError(name, taken, multi ? details.environment : null, source === "service");
  const manyErr = clashes.length
    ? `${clashes.join(", ")} already ${clashes.length === 1 ? "exists" : "exist"} in ${multi ? env : "this project"}. Rename ${clashes.length === 1 ? "it" : "them"} in the file, or leave ${clashes.length === 1 ? "it" : "them"} out.`
    : undefined;

  const linkApps = useMemo(() => (source === "service" ? linkable(p.apps, details.environment) : []), [source, p.apps, details.environment]);
  const links = details.links.filter((id) => linkApps.some((a) => a.id === id));
  const pending = conflict?.apps.filter((a) => links.includes(a.id)) ?? [];
  const shownConflict = conflict && pending.length ? { ...conflict, apps: pending } : null;

  const readingRepo = step === 2 && source === "git" && waitsForRead({ picked: !!git.picked, branch: git.branch, port: git.build.port, edited: git.edited, detect: git.detect.state });
  const urlUnread = step === 2 && source === "git" && !git.picked && git.byUrl && !parseRepo(git.url);

  const pick = (s: SourceType) => {
    setSource(s);
    setTried(0);
    setStep(2);
  };

  const pickTemplate = (row: TemplateRow) => {
    setTemplate(draftFor(row, taken, !!offer?.available));
    setTried(0);
    setStep(3);
  };

  const row = template.picked;
  const tplName = row ? templateNameError(row, template.name, taken) : undefined;
  const tplHost = templateHostError(template);
  const tplInputs = Object.fromEntries((row?.inputs ?? []).map((i) => [i.key, templateInputError(i.type, template.inputs[i.key])]));

  const installTemplate = async () => {
    setTried(3);
    if (!row || tplName || tplHost || Object.values(tplInputs).some(Boolean)) return;
    setBusy(true);
    const domain = template.domain === "custom" ? { type: "custom" as const, hostname: template.hostname.trim().toLowerCase() } : { type: template.domain };
    const r = await deployTemplate({ project: p.slug, environment: details.environment, templateId: row.id, name: template.name, domain, inputs: Object.fromEntries(Object.entries(template.inputs).map(([k, v]) => [k, v.trim()])) });
    report(r, {
      success: `${row.name} is deploying`,
      error: `Could not deploy ${row.name}`,
      what: `${p.slug} / ${template.name}${multi ? `, ${env}` : ""}`,
      action: { label: "View", onClick: () => router.push(r.ok && r.data.primaryId ? `/apps/${r.data.primaryId}` : `/projects/${p.slug}`) },
    });
    if (!r.ok) return setBusy(false);
    if (r.data.warning) toast.error("One step did not finish", { description: r.data.warning });
    onClose();
    router.refresh();
  };

  const back = () => {
    setTried(0);
    // The service, and with it the variable a link sets, may change before Create is pressed again.
    setConflict(null);
    setReplace([]);
    setStep((s) => (s === 3 ? 2 : 1));
  };

  const next = () => {
    if (busy || !source || readingRepo) return;
    if (step === 2) {
      // A template card moves on by itself: there is nothing for Continue to read.
      if (source === "template") return;
      if (source === "git" && !git.picked) {
        // On the URL view Continue reads the typed URL and picks it; the picker picks on its own.
        if (git.byUrl) setGit(pickUrl);
        return;
      }
      // Continue reads the text as it is now, not the last settled parse.
      if (source === "compose") setSettled(compose.text);
      const errors = source === "compose" ? composeErrors(compose, compose.text.trim() ? planCompose(compose.text) : null) : stepErrors;
      if (hasErrors(errors)) return setTried(2);
      setTried(0);
      setStep(3);
      return;
    }
    if (step === 3 && source === "template") return void installTemplate();
    // With a conflict on screen the primary key is "Replace and create": pressing it is the consent.
    if (step === 3) void create(shownConflict !== null);
  };

  const canTestDomain = !!offer?.available && !many && source !== "service" && (kind === "frontend" || kind === "backend");

  const create = async (replacing = false) => {
    setTried(3);
    if (!source || nameErr || manyErr || (many && !many.length)) return;
    const apps = many ?? [singleSpec(source as Exclude<SourceType, "compose" | "template">, { ...details, name, kind }, git, image, service)];
    const agreed = replacing ? [...new Set([...replace, ...pending.map((a) => a.id)])] : replace;
    if (replacing) setReplace(agreed);
    const sent = agreed.filter((id) => links.includes(id));
    const link: ServiceLink | undefined = source === "service" && links.length ? { apps: links, ...(sent.length ? { replace: sent } : {}) } : undefined;
    setBusy(true);
    const r = await createApps({ project: p.slug, environment: details.environment, apps, ...(link ? { link } : {}) });
    // A conflict created nothing: it stays in the step, as a question, instead of an error toast.
    if (!r.ok && r.code === LINK_CONFLICT && r.conflict) {
      setConflict(r.conflict);
      return setBusy(false);
    }
    setConflict(null);
    const ids = r.ok ? r.data.ids : [];
    const one = apps.length === 1;
    const vercel = one && apps[0]!.target === "vercel";
    const linked = link ? linkApps.filter((a) => link.apps.includes(a.id)).map((a) => a.name) : [];
    report(r, {
      success: one ? (vercel ? "App created. Pick its Vercel project in its Settings" : linked.length ? `App created and linked to ${listNames(linked)}` : "App created") : `${apps.length.toLocaleString("en-US")} apps created`,
      error: one ? "Could not create the app" : "Could not create the apps",
      what: `${p.slug} / ${apps.map((a) => a.name).join(", ")}${multi ? `, ${env}` : ""}`,
      // The preview creates nothing, so View opens the project instead of an app.
      action: { label: "View", onClick: () => router.push(ids[0] ? `/apps/${ids[0]}` : `/projects/${p.slug}`) },
    });
    if (!r.ok) return setBusy(false);
    if (canTestDomain && wantTestDomain && ids[0]) {
      const t = await callJson("/api/domains/test", { method: "POST", body: { appId: ids[0] } });
      if (!t.ok) toast.error("The app was created, but its test domain was not", { description: t.error });
    }
    onClose();
    router.refresh();
  };

  const count = many?.length ?? 1;
  const sub =
    step === 1
      ? "Step 1 of 3, choose a source"
      : step === 2
        ? `Step 2 of 3, ${TITLE[source!]}`
        : `Step 3 of 3, ${many || source === "template" ? "review and create" : source === "service" ? (multi ? "name, environment and links" : "name and links") : multi ? "name and environment" : "name"}`;
  // The picker owns the next step itself (Import, or Connect GitHub), so Continue waits there as a
  // plain key: one primary at a time.
  const pickFirst = step === 2 && source === "git" && !git.picked && !git.byUrl;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New app"
      sub={sub}
      icon={step === 1 || !source ? "box" : ICON[source]}
      size="lg"
      busy={busy}
      onSubmit={next}
      footer={
        <>
          {pickFirst ? <span className="dlg-note">Pick a repository to continue</span> : null}
          {step === 1 ? (
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={back}>
              Back
            </button>
          )}
          {step === 2 && source === "template" ? <span className="dlg-note">Pick a template to continue</span> : null}
          {readingRepo ? <span className="dlg-note">Reading the repository</span> : null}
          {step === 2 && source !== "template" ? (
            <button type="submit" className={pickFirst ? "btn" : "btn btn-primary"} disabled={pickFirst || readingRepo || urlUnread}>
              Continue
              <Icon name="arrowRight" size={16} className="ic-trail" />
            </button>
          ) : null}
          {step === 3 ? (
            <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="plus">
              {source === "template" ? `Deploy ${row?.name ?? ""}` : shownConflict ? "Replace and create" : count === 1 ? "Create app" : `Create ${count.toLocaleString("en-US")} apps`}
            </PendingButton>
          ) : null}
        </>
      }
    >
      <div ref={body} className="na-step" key={`${step}-${source ?? ""}`}>
        {step === 1 ? <ActionCards label="Where the app comes from" options={SOURCES} onPick={pick} last={source} /> : null}

        {step === 2 && source === "git" ? <GitSource draft={git} set={setGit} errors={shown} /> : null}
        {step === 2 && source === "image" ? <ImageSource draft={image} set={setImage} errors={shown} ctx={ctx} /> : null}
        {step === 2 && source === "service" ? <ServiceSource draft={service} set={setService} /> : null}
        {step === 2 && source === "template" ? <TemplatePicker state={templates} onPick={pickTemplate} retry={templates.reload} /> : null}
        {step === 2 && source === "compose" ? <ComposeSource draft={compose} set={setCompose} plan={plan} errors={stepErrors} showErrors={tried >= 2} /> : null}

        {step === 3 && source === "template" && row ? (
          <TemplateReview
            row={row}
            draft={template}
            set={setTemplate}
            environments={p.environments}
            environment={details.environment}
            onEnvironment={(environment) => setDetails((d) => ({ ...d, environment }))}
            nameError={tried >= 3 || template.name !== draftFor(row, taken, !!offer?.available).name ? tplName : undefined}
            hostError={tried >= 3 ? tplHost : undefined}
            inputErrors={tried >= 3 ? tplInputs : {}}
            testDomain={!!offer?.available}
          />
        ) : null}
        {step === 3 && source && source !== "template" ? (
          <DetailsStep
            testDomain={canTestDomain ? { on: wantTestDomain, set: setWantTestDomain } : undefined}
            draft={{ ...details, name, kind }}
            set={(fn) => setDetails((d) => fn({ ...d, name: d.named ? d.name : name, kind: d.kind ?? kind }))}
            environments={p.environments}
            summary={{ icon: ICON[source], title: TITLE[source], line: sourceLine(source, git, image, service, count) }}
            many={many ?? undefined}
            // The proposed name is always free, so a name error shows only once the operator edits it or presses Create.
            nameError={tried >= 3 || details.named ? nameErr : undefined}
            manyError={manyErr}
            showKind={source === "git" || source === "image"}
            showTarget={source === "git" && kind === "frontend"}
            link={source === "service" ? { key: LINK_KEY[service.service], apps: linkApps, conflict: shownConflict } : undefined}
            ctx={ctx}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
