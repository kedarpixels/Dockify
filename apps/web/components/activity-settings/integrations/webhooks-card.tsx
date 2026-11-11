"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { useStepUp } from "@/components/step-up/step-up";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CopyBox } from "@/components/ui/copy-box";
import { Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, TextInput } from "@/components/ui/field";
import { IconTile } from "@/components/ui/icon-tile";
import { PendingButton } from "@/components/ui/pending";
import { Segmented } from "@/components/ui/segmented";
import { Select, type SelectOption } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { When } from "@/components/ui/when";
import { report } from "@/lib/feedback";
import { plural } from "@/lib/format";
import { checkWebhookUrl, detectWebhook, TELEGRAM_CHAT, TELEGRAM_TOKEN, telegramFromUrl, WEBHOOK_PROVIDER_INFO, WEBHOOK_PROVIDERS, webhookUrlProblem, type WebhookProviderId } from "@/lib/webhook-providers";
import {
  LOGO_MAX_BYTES, LOGO_TYPES, PROVIDER_ICON, providerLabel, webhookRefOf,
  type Webhook, type WebhookInput, type WebhookLogo, type WebhookRef, type WebhookSaved, type WebhookTestResult,
} from "@/lib/webhooks";
import { FormKeys, Hint, IntegrationCard, ListDialog, RemoveDialog, Unavailable, useCrudCard } from "./card";
import { ExternalLink } from "@/components/ui/external-link";
import { intFetch, upsert, type Setter } from "./client";
import { WebhookMark } from "./webhook-mark";
import { afterTest } from "./webhook-test";

/*
 * Webhooks: where alerts and update notices go. Each webhook has a name, a type that decides the
 * message format (recognised from the pasted URL, or chosen), and is on or off. Which alerts reach
 * it is set per rule in Alerts. A stored URL, bot token, signing secret or access token never comes
 * back: rows show the host and the last four characters, and changing one means pasting a new one.
 * A generic webhook's signing secret is made by Dockify and shown once, when it is made.
 */

/** "Discord, Slack": each type once, in the order the webhooks were added. */
const typesOf = (list: WebhookRef[]) => [...new Set(list.map((w) => providerLabel(w.provider)))].join(", ");

// -------------------------------------------------------------------------------- the form

type LogoMode = "auto" | "url" | "upload";
interface Upload {
  name: string;
  /** The bytes as base64, what the API takes. */
  base64: string;
  /** A data URL of the same bytes, for the preview tile. */
  src: string;
}

interface Draft {
  /** "auto" follows what the URL looks like. */
  type: WebhookProviderId | "auto";
  url: string;
  /** Edit only: a new URL is being typed instead of the stored one. */
  replacing: boolean;
  name: string;
  botToken: string;
  chatId: string;
  accessToken: string;
  dropToken: boolean;
  rotate: boolean;
  enabled: boolean;
  updates: boolean;
  logo: LogoMode;
  logoUrl: string;
  upload: Upload | null;
}

const draftOf = (w: Webhook | null): Draft => ({
  type: w ? w.provider : "auto",
  url: "",
  replacing: !w,
  name: w?.name ?? "",
  botToken: "",
  chatId: w?.chatId ?? "",
  accessToken: "",
  dropToken: false,
  rotate: false,
  enabled: w?.enabled ?? true,
  updates: w?.updates ?? true,
  logo: w?.icon.choice === "upload" ? (w.icon.logoUrl ? "url" : "upload") : "auto",
  logoUrl: w?.icon.logoUrl ?? "",
  upload: null,
});

/** What the URL field says under itself: the type it found, or what to paste. */
function Detected({ provider, how }: { provider: WebhookProviderId; how: "exact" | "likely" | "fallback" | "chosen" }) {
  const label = providerLabel(provider);
  const text =
    how === "exact"
      ? `${label}, recognised from the URL`
      : how === "likely"
        ? `Looks like ${label}. Change the type if it is not`
        : how === "chosen"
          ? `Sent as ${label} messages`
          : "Not a known service: sent as signed JSON";
  return (
    <span className="wh-detect">
      <Icon name={PROVIDER_ICON[provider]} size={14} />
      <span>{text}</span>
    </span>
  );
}

/** Reads a picked file for upload, refusing what the API would refuse anyway. */
function readLogo(file: File): Promise<Upload | string> {
  if (file.size > LOGO_MAX_BYTES) return Promise.resolve("Use a logo of 128 KB or less");
  if (file.size === 0) return Promise.resolve("The file is empty");
  return new Promise((done) => {
    const r = new FileReader();
    r.onload = () => {
      const src = typeof r.result === "string" ? r.result : "";
      const base64 = src.slice(src.indexOf(",") + 1);
      done(base64 ? { name: file.name, base64, src } : "The file could not be read");
    };
    r.onerror = () => done("The file could not be read");
    r.readAsDataURL(file);
  });
}

function WebhookForm({
  editing,
  preview,
  onBack,
  onSaved,
}: {
  editing: Webhook | null;
  preview: boolean;
  onBack: () => void;
  onSaved: (saved: WebhookSaved) => void;
}) {
  const { elevate } = useStepUp();
  const [d, setD] = useState<Draft>(() => draftOf(editing));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tried, setTried] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const url = d.url.trim();
  const found = url ? detectWebhook(url) : null;
  // The type in force: the one chosen, else what the URL looks like, else what is stored.
  const provider: WebhookProviderId = d.type !== "auto" ? d.type : found ? found.provider : editing && !d.replacing ? editing.provider : "generic";
  const how = d.type !== "auto" ? "chosen" : found ? found.confidence : "fallback";
  const telegram = provider === "telegram";
  const generic = provider === "generic";
  const ntfy = provider === "ntfy";
  const fromUrl = telegram && url ? telegramFromUrl(url) : null;
  const storedUrl = editing !== null && !d.replacing;
  const typeChanged = editing !== null && provider !== editing.provider;

  // ---- checks, shown once a save was tried (the URL also as soon as it is clearly wrong)
  const urlErr = (() => {
    if (storedUrl && !typeChanged) return null;
    if (!url) {
      if (telegram) return d.botToken.trim() || (editing?.provider === "telegram" && !typeChanged) ? null : "Paste the bot token, or the bot’s URL";
      return storedUrl ? null : "Paste the webhook URL";
    }
    const checked = checkWebhookUrl(url);
    if (!checked.ok) return checked.reason;
    return webhookUrlProblem(provider, url);
  })();
  const tokenErr = telegram && d.botToken.trim() && !TELEGRAM_TOKEN.test(d.botToken.trim()) ? "Paste the token BotFather gave you: digits, a colon, then letters" : null;
  const chat = d.chatId.trim() || fromUrl?.chatId || "";
  const chatErr = telegram && (!chat ? "Add the chat the bot posts to" : !TELEGRAM_CHAT.test(chat) ? "Use the chat’s numeric ID, or @name for a public channel" : null);
  const nameErr = d.name.trim().length > 60 ? "Use 60 characters or fewer" : /[<>]/.test(d.name) ? "Leave out angle brackets" : null;
  const tokenAccessErr = ntfy && d.accessToken.trim() && !/^[\x21-\x7e]{8,256}$/.test(d.accessToken.trim()) ? "Paste the access token as ntfy shows it" : null;
  const logoErr = generic && d.logo === "url" && !/^https:\/\/\S+$/.test(d.logoUrl.trim()) ? "Use an https link to the logo" : generic && d.logo === "upload" && !d.upload && editing?.icon.choice !== "upload" ? "Choose an image" : null;
  const live = (e: string | null) => (tried || (url.length > 12 && e === urlErr) ? e : null);
  const shown = (e: string | null | false) => (tried && e ? e : null);
  const valid = !urlErr && !tokenErr && !chatErr && !nameErr && !tokenAccessErr && !logoErr;

  // What reaches the endpoint, for a test and for a save.
  const target = (): WebhookInput => ({
    provider,
    ...(url ? { url } : {}),
    ...(telegram && d.botToken.trim() ? { botToken: d.botToken.trim() } : {}),
    ...(telegram && d.chatId.trim() ? { chatId: d.chatId.trim() } : {}),
    ...(ntfy && d.accessToken.trim() ? { accessToken: d.accessToken.trim() } : {}),
  });

  const logoInput = (): WebhookLogo | undefined => {
    if (!generic) return undefined;
    if (d.logo === "url") return d.logoUrl.trim() !== (editing?.icon.logoUrl ?? "") || editing?.icon.choice !== "upload" ? { choice: "url", url: d.logoUrl.trim() } : undefined;
    if (d.logo === "upload") return d.upload ? { choice: "upload", image: d.upload.base64 } : undefined;
    return editing && editing.icon.choice === "upload" ? { choice: "auto" } : undefined;
  };

  const test = async () => {
    setTried(true);
    if (testing || urlErr || tokenErr || chatErr) return;
    setTesting(true);
    // The stored endpoint when nothing about it changed; the typed one otherwise.
    const changed = Boolean(url || d.botToken.trim() || (telegram && d.chatId.trim() !== (editing?.chatId ?? "")) || typeChanged);
    const body = editing && !changed ? { id: editing.id } : target();
    const r = await intFetch<WebhookTestResult>("/webhooks/test", { method: "POST", body });
    setTesting(false);
    report(r, { success: "Test message sent", error: "Could not send the test message", what: r.ok ? `${providerLabel(r.data.provider)} answered ${r.data.status} in ${r.data.latencyMs} ms` : undefined, preview });
  };

  const submit = async () => {
    setTried(true);
    if (!valid || busy) return;
    setBusy(true);
    const logo = logoInput();
    let body: WebhookInput;
    if (!editing) {
      body = { ...target(), ...(d.name.trim() ? { name: d.name.trim() } : {}), enabled: d.enabled, updates: d.updates, ...(logo ? { logo } : {}) };
    } else {
      body = {
        ...(d.name.trim() && d.name.trim() !== editing.name ? { name: d.name.trim() } : {}),
        ...(typeChanged || url || d.botToken.trim() || (telegram && d.chatId.trim() !== (editing.chatId ?? "")) ? target() : {}),
        ...(ntfy && d.dropToken && !d.accessToken.trim() ? { accessToken: null } : {}),
        ...(generic && d.rotate ? { signingSecret: "rotate" } : {}),
        ...(d.enabled !== editing.enabled ? { enabled: d.enabled } : {}),
        ...(d.updates !== editing.updates ? { updates: d.updates } : {}),
        ...(logo ? { logo } : {}),
      };
    }
    const r = await elevate(
      () => intFetch<WebhookSaved>(editing ? `/webhooks/${encodeURIComponent(editing.id)}` : "/webhooks", { method: editing ? "PATCH" : "POST", body }),
      { what: editing ? "Changing a webhook" : "Adding a webhook" },
    );
    setBusy(false);
    report(r, { success: editing ? "Webhook saved" : "Webhook added", error: editing ? "Could not save the webhook" : "Could not add the webhook", what: r.ok ? r.data.webhook.name : undefined, preview });
    if (r.ok) onSaved(r.data);
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    const got = await readLogo(f);
    if (typeof got === "string") {
      setUploadErr(got);
      return;
    }
    setUploadErr(null);
    set({ upload: got });
  };

  const typeOptions: SelectOption<WebhookProviderId | "auto">[] = [
    { value: "auto", label: "From the URL", icon: "link" },
    ...WEBHOOK_PROVIDERS.map((p) => ({ value: p, label: providerLabel(p), icon: PROVIDER_ICON[p] })),
  ];

  // The logo the form shows now: a fresh upload, else what is stored.
  const logoPreview = d.upload?.src ?? null;

  return (
    <Dialog
      open
      onClose={onBack}
      title={editing ? "Edit webhook" : "Add webhook"}
      sub={editing ? `${providerLabel(editing.provider)}, ${editing.host}` : "Alerts and update notices, in each service’s own format"}
      icon="webhook"
      size="lg"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <PendingButton className="btn int-ft-start" pending={testing} disabled={busy} onClick={() => void test()}>
            Send test
          </PendingButton>
          <FormKeys onCancel={onBack} busy={busy} icon={editing ? "check" : "plus"}>
            {editing ? "Save" : "Add webhook"}
          </FormKeys>
        </>
      }
    >
      {storedUrl ? (
        <div className="fld">
          <span className="fld-label">{telegram ? "Bot" : "Webhook URL"}</span>
          <div className="int-stored">
            <span className="int-stored-value">
              <span className="int-wrap">{editing.host}</span>
              {editing.hint ? <Hint hint={editing.hint} what={`${editing.name} ${telegram ? "bot token" : "URL"}`} /> : null}
            </span>
            <button type="button" className="btn" aria-label={`Replace the ${telegram ? "bot" : "URL"} of ${editing.name}`} onClick={() => set({ replacing: true })}>
              Replace
            </button>
          </div>
        </div>
      ) : (
        <Field
          label={telegram ? "Bot URL" : "Webhook URL"}
          hint={url && !urlErr ? <Detected provider={provider} how={how} /> : telegram ? "Optional: paste https://api.telegram.org/bot<token>/sendMessage, or fill in the token and chat below." : WEBHOOK_PROVIDER_INFO[provider].paste}
          error={live(urlErr)}
        >
          {(ids) => (
            <div className="as-inline">
              <TextInput
                ids={ids}
                type="url"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                placeholder="https://"
                value={d.url}
                onChange={(e) => set({ url: e.target.value })}
                data-autofocus
              />
              {editing ? (
                <button type="button" className="btn" aria-label={`Keep current URL of ${editing.name}`} onClick={() => set({ replacing: false, url: "" })}>
                  Keep current
                </button>
              ) : null}
            </div>
          )}
        </Field>
      )}

      <div className="int-form-grid">
        <Field label="Type" hint="Decides the message format">
          {(ids) => <Select ids={ids} label="Type" value={d.type} options={typeOptions} onChange={(type) => set({ type })} />}
        </Field>
        <Field label="Name" hint="How alert rules list it" error={shown(nameErr)}>
          {(ids) => <TextInput ids={ids} autoComplete="off" maxLength={60} placeholder={providerLabel(provider)} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
      </div>

      {telegram ? (
        <div className="int-form-grid">
          <Field
            label="Bot token"
            hint={editing?.provider === "telegram" ? `Leave empty to keep the token ending ${editing.hint}.` : <>From BotFather, after /newbot. <ExternalLink href="https://core.telegram.org/bots/tutorial#obtain-your-bot-token">How to</ExternalLink></>}
            error={shown(tokenErr)}
          >
            {(ids) => <TextInput ids={ids} type="password" autoComplete="off" spellCheck={false} value={d.botToken} onChange={(e) => set({ botToken: e.target.value })} />}
          </Field>
          <Field label="Chat" hint="The numeric chat ID, or @name for a public channel. Add the bot to the chat first." error={shown(chatErr)}>
            {(ids) => <TextInput ids={ids} autoComplete="off" spellCheck={false} placeholder={fromUrl?.chatId ?? "-1001234567890"} value={d.chatId} onChange={(e) => set({ chatId: e.target.value })} />}
          </Field>
        </div>
      ) : null}

      {ntfy ? (
        <Field
          label="Access token"
          hint={editing?.accessTokenHint && !d.dropToken ? `Leave empty to keep the token ending ${editing.accessTokenHint}.` : "Only for a protected topic. Leave empty for a public one."}
          error={shown(tokenAccessErr)}
        >
          {(ids) => (
            <div className="as-inline">
              <TextInput ids={ids} type="password" autoComplete="off" spellCheck={false} placeholder="tk_" value={d.accessToken} onChange={(e) => set({ accessToken: e.target.value })} />
              {editing?.accessTokenHint ? (
                <button type="button" className="btn" onClick={() => set({ dropToken: !d.dropToken, accessToken: "" })}>
                  {d.dropToken ? "Keep token" : "Remove token"}
                </button>
              ) : null}
            </div>
          )}
        </Field>
      ) : null}

      {generic ? (
        <>
          {editing?.provider === "generic" && editing.signingSecretHint ? (
            <div className="fld">
              <span className="fld-label">Signing secret</span>
              <div className="int-stored">
                <span className="int-stored-value">
                  {d.rotate ? <span>A new secret is made when you save</span> : <Hint hint={editing.signingSecretHint} what={`${editing.name} signing secret`} />}
                </span>
                <button type="button" className="btn" onClick={() => set({ rotate: !d.rotate })}>
                  {d.rotate ? "Keep current" : "New secret"}
                </button>
              </div>
            </div>
          ) : (
            <Callout tone="info" icon="key">
              Dockify signs every request with a secret it makes when you save, and shows it once. Your endpoint checks the X-Dockify-Signature header with it.
            </Callout>
          )}

          <Field label="Logo" hint={d.logo === "auto" ? "The icon of the webhook’s site, which Dockify fetches." : d.logo === "url" ? "Dockify downloads it once and keeps a copy. PNG, JPEG, WebP, GIF, ICO or SVG, at most 128 KB." : "PNG, JPEG, WebP, GIF, ICO or SVG, at most 128 KB."} error={shown(logoErr) ?? uploadErr}>
            {(ids) => (
              <div className="wh-logo-field">
                <Segmented
                  ids={ids}
                  label="Where the logo comes from"
                  value={d.logo}
                  onChange={(logo) => set({ logo })}
                  options={[
                    { value: "auto", label: "Site icon" },
                    { value: "url", label: "Link" },
                    { value: "upload", label: "Upload" },
                  ]}
                />
                {d.logo === "url" ? (
                  <TextInput type="url" inputMode="url" spellCheck={false} autoComplete="off" aria-label="Logo link" placeholder="https://example.com/logo.svg" value={d.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} />
                ) : null}
                {d.logo === "upload" ? (
                  <div className="wh-upload">
                    <IconTile size="lg">
                      {logoPreview ? (
                        // A data URL of the file just picked; the saved logo comes back from Dockify.
                        <img src={logoPreview} alt="" width={20} height={20} className="wh-logo" />
                      ) : editing ? (
                        <WebhookMark webhook={editing} size={20} />
                      ) : (
                        <Icon name="image" size={20} />
                      )}
                    </IconTile>
                    <span className="wh-upload-name">{d.upload?.name ?? (editing?.icon.choice === "upload" ? "The current logo" : "No image chosen")}</span>
                    <input ref={file} type="file" accept={LOGO_TYPES} hidden onChange={(e) => void pickFile(e.target.files?.[0])} />
                    <button type="button" className="btn" onClick={() => file.current?.click()}>
                      Choose image
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </Field>
        </>
      ) : null}

      <div className="wh-switches">
        <label className="int-switch-row">
          <span className="two">
            <span className="two-main">Webhook on</span>
            <span className="two-sub">An off webhook keeps its settings and sends nothing.</span>
          </span>
          <Switch checked={d.enabled} onChange={(enabled) => set({ enabled })} label="Webhook on" />
        </label>
        <label className="int-switch-row">
          <span className="two">
            <span className="two-main">Dockify update notices</span>
            <span className="two-sub">A new release, an update installed, or one that failed and rolled back.</span>
          </span>
          <Switch checked={d.updates} onChange={(updates) => set({ updates })} label="Dockify update notices" />
        </label>
      </div>
      <span className="fld-note">Which alerts reach it is set on each rule in Alerts.</span>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------- the list

function WebhookRow({ w, now, testing, onTest, onEdit, onRemove }: { w: Webhook; now: number; testing: boolean; onTest: () => void; onEdit: () => void; onRemove: () => void }) {
  return (
    <li className="soft-row int-row" data-hover="true">
      <IconTile>
        <WebhookMark webhook={w} size={14} />
      </IconTile>
      <span className="two">
        <span className="two-main int-row-title">
          <span className="ellipsis" title={w.name}>
            {w.name}
          </span>
          {!w.enabled ? <Chip size="xs">Off</Chip> : w.status === "failing" ? <Chip size="xs" tone="bad">Failing</Chip> : null}
        </span>
        <span className="two-sub int-sub-line">
          <span>{providerLabel(w.provider)}</span>
          <span className="int-wrap">{w.chatId ? `${w.host}, chat ${w.chatId}` : w.host}</span>
          {w.hint ? <Hint hint={w.hint} what={`${w.name} ${w.provider === "telegram" ? "bot token" : "URL"}`} /> : null}
        </span>
        <span className={w.status === "failing" ? "two-sub wh-state tone-bad" : "two-sub wh-state"}>
          {w.status === "failing" && w.error ? (
            w.error
          ) : (
            <>
              <When iso={w.lastSentAt} now={now} prefix="Last sent" fallback="Nothing sent yet" />
              {`, ${plural(w.rules, "alert rule")}${w.updates ? " and update notices" : ""}`}
            </>
          )}
        </span>
      </span>
      <span className="int-row-keys">
        <PendingButton className="btn btn-xs" pending={testing} aria-label={`Send test to ${w.name}`} onClick={onTest}>
          Send test
        </PendingButton>
        <button type="button" className="btn btn-xs" aria-label={`Edit ${w.name}`} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn btn-xs" aria-label={`Remove ${w.name}`} onClick={onRemove}>
          Remove
        </button>
      </span>
    </li>
  );
}

type Loaded = { state: "loading" } | { state: "ready"; list: Webhook[] } | { state: "error"; error: string };

export function WebhooksCard({ value, onChange, now, preview }: { value: WebhookRef[]; onChange: Setter<WebhookRef[]>; now: number; preview: boolean }) {
  const { elevate } = useStepUp();
  // Add goes straight to the form when there is nothing to list yet.
  const card = useCrudCard<Webhook>(value.length > 0);
  const { open } = card;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [testing, setTesting] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  // Bumped by Try again, so a failed read is asked again without closing the dialog.
  const [attempt, setAttempt] = useState(0);

  // The full list (hints, states) loads when the dialog opens; the row needs only the summary.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void intFetch<Webhook[]>("/webhooks").then((r) => {
      if (!live) return;
      setLoaded(r.ok ? { state: "ready", list: r.data } : { state: "error", error: r.error });
    });
    return () => {
      live = false;
    };
  }, [open, attempt]);

  const list = loaded.state === "ready" ? loaded.list : [];
  const put = (w: Webhook) => {
    setLoaded((s) => (s.state === "ready" ? { state: "ready", list: upsert(s.list, w) } : { state: "ready", list: [w] }));
    onChange((refs) => upsert(refs, webhookRefOf(w)));
  };

  const test = async (w: Webhook) => {
    setTesting(w.id);
    const r = await intFetch<WebhookTestResult>("/webhooks/test", { method: "POST", body: { id: w.id } });
    setTesting(null);
    report(r, { success: "Test message sent", error: "Could not send the test message", what: r.ok ? `${w.name}: ${providerLabel(w.provider)} answered ${r.data.status} in ${r.data.latencyMs} ms` : w.name, preview });
    // A test that never left says nothing about the endpoint: the row keeps its state (webhook-test.ts).
    const next = afterTest(w, r, new Date().toISOString());
    if (next !== w) put(next);
  };

  const remove = async (w: Webhook) => {
    const r = await elevate(() => intFetch<{ ok: true }>(`/webhooks/${encodeURIComponent(w.id)}`, { method: "DELETE" }), { what: "Removing a webhook" });
    report(r, { success: "Webhook removed", error: "Could not remove the webhook", what: w.name, preview });
    if (!r.ok) throw new Error(r.error);
    setLoaded((s) => (s.state === "ready" ? { state: "ready", list: s.list.filter((x) => x.id !== w.id) } : s));
    onChange((refs) => refs.filter((x) => x.id !== w.id));
  };

  return (
    <>
      <IntegrationCard
        id="int-webhooks"
        icon="webhook"
        name="Webhooks"
        purpose="Send alerts and update notices to Discord, Slack, Teams and more."
        status={value.length ? "connected" : "disconnected"}
        meta={value.length ? typesOf(value) : null}
      >
        <button type="button" className="btn btn-sm" onClick={card.start}>
          {value.length ? "Manage" : "Add webhook"}
        </button>
      </IntegrationCard>

      <ListDialog open={card.listOpen} onClose={card.close} onAdd={card.add} addLabel="Add webhook" title="Webhooks" sub={value.length ? plural(value.length, "webhook") : "Where alerts and update notices go"} icon="webhook">
        {loaded.state === "loading" ? (
          <SkelRows rows={Math.max(1, value.length)} height={72} template="24px minmax(0,1fr) 220px" cols={[24, { w: "45%", lines: 2 }, 210]} label="Loading webhooks" />
        ) : loaded.state === "error" ? (
          <Unavailable
            icon="webhook"
            title="Webhooks are unavailable"
            error={loaded.error}
            onRetry={() => {
              setLoaded({ state: "loading" });
              setAttempt((n) => n + 1);
            }}
          />
        ) : !list.length ? (
          <Empty icon="webhook" title="No webhooks yet" body="Add Discord, Slack, Microsoft Teams, Google Chat, Telegram, Mattermost, Rocket.Chat, ntfy or any HTTPS endpoint." />
        ) : (
          <ul className="soft-list int-list">
            {list.map((w) => (
              <WebhookRow
                key={w.id}
                w={w}
                now={now}
                testing={testing === w.id}
                onTest={() => void test(w)}
                onEdit={() => card.edit(w)}
                onRemove={() => card.setRemoving(w)}
              />
            ))}
          </ul>
        )}
      </ListDialog>

      {card.form ? (
        <WebhookForm
          key={card.form.editing?.id ?? "new"}
          editing={card.form.editing}
          preview={preview}
          onBack={card.back}
          onSaved={(saved) => {
            put(saved.webhook);
            card.toList();
            if (saved.signingSecret) setSecret({ name: saved.webhook.name, value: saved.signingSecret });
          }}
        />
      ) : null}

      {/* A made signing secret, once: Dockify keeps only its last four characters to show. */}
      <Dialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        title="Signing secret"
        sub={secret?.name}
        icon="key"
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setSecret(null)}>
            Done
          </button>
        }
      >
        {secret ? (
          <>
            <CopyBox value={secret.value} what="signing secret" code />
            <span className="fld-note">
              Copy it now: Dockify shows it once. Each request carries X-Dockify-Timestamp and X-Dockify-Signature, sha256= the HMAC SHA-256 of the timestamp, a dot and the raw body, keyed by this secret.
            </span>
          </>
        ) : null}
      </Dialog>

      <RemoveDialog
        row={card.removing}
        onClose={() => card.setRemoving(null)}
        title="Remove webhook"
        sub={card.removing?.name}
        body={
          card.removing
            ? `Dockify stops sending to ${card.removing.name} and forgets its URL.${
                card.removing.rules === 1 ? " The alert rule that sent there keeps its other channels." : card.removing.rules > 1 ? ` The ${card.removing.rules} alert rules that sent there keep their other channels.` : ""
              }`
            : undefined
        }
        label="Remove webhook"
        onRemove={remove}
      />
    </>
  );
}
