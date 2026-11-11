"use client";

import { useEffect, useRef, useState } from "react";
import { gitFetch, startInstall, useInstallations } from "@/components/git/client";
import { Icon } from "@/components/icon";
import { useStepUp } from "@/components/step-up/step-up";
import { Avatar } from "@/components/ui/avatar";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, TextInput } from "@/components/ui/field";
import { IconTile } from "@/components/ui/icon-tile";
import { PendingButton } from "@/components/ui/pending";
import { Segmented } from "@/components/ui/segmented";
import { SkelRows } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { describe, report } from "@/lib/feedback";
import { plural } from "@/lib/format";
import type { GitInstallation } from "@/lib/pages/git";
import type { GitHubApp, GitHubManifest, IntegrationStatus } from "@/lib/pages/integrations";
import { Facts, FormKeys, IntegrationCard, Unavailable } from "./card";
import { ExternalLink } from "@/components/ui/external-link";
import { intFetch, listing } from "./client";

// Creating the App posts Dockify's manifest to GitHub, which comes back through the API with
// ?github=app-created, app-failed, installed or failed. Remove App only forgets it here.

const BACK: Record<string, { ok: boolean; title: string; body: string }> = {
  installed: { ok: true, title: "GitHub account connected", body: "Its repositories now show when you add an app" },
  failed: { ok: false, title: "Could not connect the GitHub account", body: "GitHub did not finish the install. Try Connect again" },
  "app-created": { ok: true, title: "GitHub App created", body: "Connect an account so its repositories show when you add an app" },
  "app-failed": { ok: false, title: "Could not create the GitHub App", body: "GitHub did not finish creating it. Try again" },
};

/** What the App may do, as the manifest asks for it (apps/api, buildManifest). */
const PERMISSIONS = [
  { label: "Repository contents", value: "Read, to clone and build" },
  { label: "Pull requests", value: "Write, for the preview comment" },
  { label: "Commit statuses", value: "Write, for the preview status" },
  { label: "Events", value: "Push and pull request" },
];

const access = (i: GitInstallation) =>
  i.repositorySelection === "all"
    ? "All repositories"
    : i.selectedCount === undefined
      ? "Selected repositories"
      : `${i.selectedCount.toLocaleString("en-US")} selected`;

function AccountRow({ i, onDisconnect, disabled }: { i: GitInstallation; onDisconnect: () => void; disabled: boolean }) {
  const org = i.account.type === "Organization";
  return (
    <li className="soft-row int-row" data-hover="true">
      {org && !i.account.avatarUrl ? (
        <IconTile>
          <Icon name="org" />
        </IconTile>
      ) : (
        <Avatar url={i.account.avatarUrl} size={24} />
      )}
      <span className="two">
        <span className="two-main int-row-title">
          <span className="ellipsis" title={i.account.login}>
            {i.account.login}
          </span>
          <Chip size="xs">{org ? "Organization" : "User"}</Chip>
        </span>
        <span className="two-sub">{access(i)}</span>
      </span>
      <span className="int-row-keys">
        <a className="btn btn-xs" href={i.manageUrl} target="_blank" rel="noopener noreferrer" aria-label={`Manage ${i.account.login} on GitHub, opens in a new tab`}>
          Manage
        </a>
        <button type="button" className="btn btn-xs" aria-label={`Disconnect ${i.account.login}`} onClick={onDisconnect} disabled={disabled}>
          Disconnect
        </button>
      </span>
    </li>
  );
}

/** A form POST is the one way GitHub takes a manifest. The state in postUrl is single use and tied to this session. */
function postManifest(m: GitHubManifest): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = m.postUrl;
  form.hidden = true;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(m.manifest);
  form.append(field);
  document.body.append(form);
  form.submit();
}

const ORG = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

/** GitHub has no API for the App's logo; it is uploaded on this page. */
function appSettingsUrl(app: GitHubApp) {
  if (!app.owner) return app.htmlUrl;
  return app.owner.type === "Organization" ? `https://github.com/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${encodeURIComponent(app.slug)}` : `https://github.com/settings/apps/${encodeURIComponent(app.slug)}`;
}

function CreateAppDialog({ open, onClose, preview }: { open: boolean; onClose: () => void; preview: boolean }) {
  const { elevate } = useStepUp();
  const [owner, setOwner] = useState<"me" | "org">("me");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const orgErr = owner === "org" && !ORG.test(org.trim()) ? "Use the organization’s GitHub login: letters, numbers and single hyphens" : null;

  const go = async () => {
    setTried(true);
    if (busy || orgErr) return;
    setBusy(true);
    const r = await elevate(
      () => intFetch<GitHubManifest>("/github/app/manifest", { method: "POST", body: owner === "org" ? { organization: org.trim() } : {} }),
      { what: "Creating the GitHub App" },
    );
    if (r.ok && r.data.postUrl) {
      // The browser is leaving for GitHub, so the key stays pending. If the page is still here long
      // after (a blocked post gives no error to catch), the key comes back rather than spin forever.
      postManifest(r.data);
      window.setTimeout(() => {
        setBusy(false);
        toast.error("GitHub did not open", { description: "Check for a blocked page in your browser, then try again" });
      }, 15_000);
      return;
    }
    setBusy(false);
    if (r.ok) {
      toast.success("GitHub App ready to create", { description: describe("The design preview does not go to GitHub", { preview }) });
      onClose();
      return;
    }
    report(r, { success: "", error: "Could not start creating the GitHub App", preview });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create GitHub App"
      sub="This server’s own App, created on GitHub"
      icon="github"
      size="lg"
      busy={busy}
      onSubmit={() => void go()}
      footer={
        <FormKeys onCancel={onClose} busy={busy} trailing="arrowRight">
          Continue to GitHub
        </FormKeys>
      }
    >
      <p className="dlg-text">
        GitHub creates a private App for this server from Dockify’s settings, and you confirm its name there. Then connect the accounts whose repositories you deploy.
      </p>
      <Field label="Owner" hint={owner === "me" ? "The account you are signed in to on GitHub." : "A private App installs only on its owner, so pick the organization whose repositories you deploy."}>
        {(ids) => (
          <Segmented
            ids={ids}
            label="Who owns the App"
            value={owner}
            onChange={setOwner}
            options={[
              { value: "me", label: "My account" },
              { value: "org", label: "An organization" },
            ]}
          />
        )}
      </Field>
      {owner === "org" ? (
        <Field label="Organization" hint="Its login, as in github.com/acme. You need to be an owner of it." error={tried ? orgErr : null}>
          {(ids) => <TextInput ids={ids} autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="acme" value={org} onChange={(e) => setOrg(e.target.value)} data-autofocus />}
        </Field>
      ) : null}
      <div className="fld">
        <span className="fld-label">What the App may do</span>
        <Facts items={PERMISSIONS} />
      </div>
    </Dialog>
  );
}

export function GithubCard({ initialAccounts, initialApp, now, preview }: { initialAccounts: number; initialApp: GitHubApp | null; now: number; preview: boolean }) {
  const { elevate } = useStepUp();
  const [app, setApp] = useState(initialApp);
  const [installations, reload, setInstallations] = useInstallations();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [removingApp, setRemovingApp] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [leaving, setLeaving] = useState<GitInstallation | null>(null);
  const welcomed = useRef(false);

  // Says how it went once and drops the flag, so a reload stays quiet.
  useEffect(() => {
    const url = new URL(window.location.href);
    const back = BACK[url.searchParams.get("github") ?? ""];
    if (welcomed.current || !back) return;
    welcomed.current = true;
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", url);
    if (back.ok) toast.success(back.title, { description: describe(back.body, { preview }) });
    else toast.error(back.title, { description: back.body });
  }, [preview]);

  const connect = async () => {
    setInstalling(true);
    // On success the browser is leaving for GitHub, so the key stays pending.
    if (!(await startInstall())) setInstalling(false);
  };

  const disconnect = async (i: GitInstallation) => {
    const r = await elevate(() => gitFetch<{ ok: true }>(`/installations/${encodeURIComponent(i.id)}`, { method: "DELETE" }), { what: "Disconnecting a GitHub account" });
    report(r, { success: "GitHub account disconnected", error: "Could not disconnect the account", what: i.account.login });
    if (!r.ok) throw new Error(r.error);
    setInstallations((s) => (s.state === "ready" ? { ...s, list: s.list.filter((x) => x.id !== i.id) } : s));
  };

  const removeApp = async () => {
    if (!app) return;
    const r = await elevate(() => intFetch<{ ok: true }>("/github/app", { method: "DELETE" }), { what: "Removing the GitHub App" });
    report(r, { success: "GitHub App removed", error: "Could not remove the GitHub App", what: `${app.slug}. Delete it on GitHub too`, preview });
    if (!r.ok) throw new Error(r.error);
    setApp(null);
    setOpen(false);
    setInstallations((s) => (s.state === "ready" ? { ...s, list: [] } : s));
  };

  const list = installations.state === "ready" ? installations.list : [];
  // With no API at all the card reads Not connected, not Error; Connect then says why.
  const noSource = installations.state === "error" && installations.source === "none";
  const status: IntegrationStatus =
    !app
      ? "disconnected"
      : installations.state === "loading"
        ? initialAccounts
          ? "connected"
          : "disconnected"
        : installations.state === "error"
          ? noSource
            ? "disconnected"
            : "error"
          : list.length
            ? "connected"
            : "disconnected";
  const count = installations.state === "ready" ? list.length : initialAccounts;
  const meta = !app
    ? null
    : installations.state === "error" && !noSource
      ? "Connected accounts are unavailable"
      : count
        ? installations.state === "ready"
          ? listing(list.map((i) => i.account.login))
          : plural(count, "account")
        : `${app.slug}, no account connected yet`;

  return (
    <>
      <IntegrationCard id="int-github" icon="github" name="GitHub" purpose="Import repositories and deploy on every push." status={status} meta={meta}>
        {!app ? (
          <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
            Create GitHub App
          </button>
        ) : status === "disconnected" ? (
          <PendingButton className="btn btn-sm" onClick={() => void connect()} pending={installing}>
            Connect
            <span className="sr">, continues on GitHub</span>
          </PendingButton>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            Manage
          </button>
        )}
      </IntegrationCard>

      <CreateAppDialog key={creating ? "open" : "closed"} open={creating} onClose={() => setCreating(false)} preview={preview} />

      <Dialog
        open={open && app !== null}
        onClose={() => setOpen(false)}
        title="GitHub"
        sub="This server’s GitHub App and the accounts it can read"
        icon="github"
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn-quiet-danger int-ft-start" onClick={() => setRemovingApp(true)}>
              Remove App
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Done
            </button>
            <PendingButton className="btn btn-primary" onClick={() => void connect()} pending={installing} icon="plus">
              Add account
            </PendingButton>
          </>
        }
      >
        {app ? (
          <Facts
            items={[
              { label: "App", value: <ExternalLink href={app.htmlUrl}>{app.slug}</ExternalLink> },
              { label: "Owner", value: app.owner ? `${app.owner.login}, ${app.owner.type === "Organization" ? "organization" : "personal account"}` : "Set up by the installer" },
              { label: "Created", value: <When iso={app.createdAt} now={now} fallback="Unknown" /> },
              { label: "Webhook", value: "Push and pull request events reach this server" },
            ]}
          />
        ) : null}
        {app ? (
          <p className="fld-note">
            Give the bot its logo:{" "}
            <a className="ext-link" href="/dockify-github-app-logo.png" download>
              download it
            </a>
            , then upload it in the <ExternalLink href={appSettingsUrl(app)}>App’s settings</ExternalLink>.
          </p>
        ) : null}
        {installations.state === "loading" ? (
          <SkelRows rows={2} height={56} template="24px minmax(0,1fr) 168px" cols={[24, { w: "40%", lines: 2 }, 160]} label="Loading GitHub accounts" />
        ) : installations.state === "error" ? (
          <Unavailable icon="github" title="GitHub accounts are unavailable" error={installations.error} onRetry={() => void reload()} />
        ) : !list.length ? (
          <Empty icon="github" title="No GitHub accounts yet" body="Add an account or organization, then import its repositories when you add an app." />
        ) : (
          <>
            <Callout tone="info">Which repositories Dockify may read is set on GitHub, under Manage.</Callout>
            <ul className="soft-list int-list">
              {list.map((i) => (
                <AccountRow key={i.id} i={i} onDisconnect={() => setLeaving(i)} disabled={leaving !== null} />
              ))}
            </ul>
          </>
        )}
      </Dialog>

      {/* Connecting again undoes it, so the default key, with no glyph and no typed name. */}
      <ConfirmDialog
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        title="Disconnect GitHub account"
        body={
          leaving
            ? `This uninstalls the Dockify GitHub App from ${leaving.account.login}. Projects imported from it keep their settings but stop deploying on push until it is connected again.`
            : undefined
        }
        confirmLabel="Disconnect GitHub"
        onConfirm={() => (leaving ? disconnect(leaving) : undefined)}
        returnFocus={() => document.querySelector<HTMLElement>(".int-list .int-row-keys a") ?? document.querySelector<HTMLElement>(".dlg .btn-primary")}
      />

      {/* Losing the keys cannot be undone here: a new App is created from scratch, so the name is typed. */}
      <ConfirmDialog
        open={removingApp}
        onClose={() => setRemovingApp(false)}
        tone="danger"
        title="Remove GitHub App"
        sub={app?.slug}
        body={
          app
            ? `Dockify forgets this App’s keys and ${plural(count, "connected account")}. Apps imported from it keep their settings but stop cloning and deploying on push until a new App is connected. Delete the App on GitHub afterwards, from its page.`
            : undefined
        }
        confirmLabel="Remove App"
        confirmIcon="trash"
        confirmText={app?.slug}
        onConfirm={() => removeApp()}
      />
    </>
  );
}
