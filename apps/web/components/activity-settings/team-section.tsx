"use client";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { createInvite, readTeam, readTokens, revokeInvite, saveTeam, type TeamChange, type TeamRole } from "@/app/(console)/settings/actions";
import { Icon } from "@/components/icon";
import { RowMenu, type RowMenuItem } from "@/components/project-extras/row-menu";
import { Avatar } from "@/components/ui/avatar";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CopyBox } from "@/components/ui/copy-box";
import { CopyTextButton } from "@/components/ui/copy-button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { describe, errText, report } from "@/lib/feedback";
import type { Invite, Role, SettingsData, TeamMember } from "@/lib/pages/activity-settings";
import { Group, settle, Until } from "./form";
import { Segment, SectionTabs } from "./section-tabs";
import type { SectionProps } from "./settings-view";
import type { Elevate } from "@/components/step-up/step-up";

// Changes act at once, so there is no save bar. The API refuses removing the last admin (409
// LAST_ADMIN) and the UI never offers it.

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", viewer: "Viewer" };
/** Polled for about two minutes: the worker sends within seconds. */
const INVITE_POLL_MS = 4_000;
const INVITE_POLLS = 30;
const ROLE_OPTIONS: Array<{ value: TeamRole; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "viewer", label: "Viewer" },
];
const ROLE_HINT: Record<TeamRole, string> = {
  admin: "Admins do everything: deploys, variables, team, tokens and instance settings.",
  viewer: "Viewers see everything and change nothing.",
};
const LAST_ADMIN = "At least one admin is required";

function GitHubLink({ login, verified }: { login: string; verified: boolean }) {
  return (
    <>
      <span className="set-tm-gh">
        <Icon name="github" size={14} />
        <span className="set-tm-gh-login">{login}</span>
      </span>
      {verified ? null : (
        <Chip size="xs" tone="pending">
          Unverified
        </Chip>
      )}
    </>
  );
}

/** A list with no key in any row drops the key cell (see .set-tm-list in the stylesheet). */
function MemberRow({
  m,
  now,
  self,
  canManage,
  lastAdmin,
  pending,
  onRole,
  onRemove,
  onApprove,
  onUnlink,
}: {
  m: TeamMember;
  now: number;
  self: boolean;
  canManage: boolean;
  lastAdmin: boolean;
  pending: boolean;
  onRole: (r: TeamRole) => void;
  onRemove: () => void;
  onApprove: () => void;
  onUnlink: () => void;
}) {
  const pick = canManage && !self;
  const linked = pick && m.githubLogin !== null;
  const items: RowMenuItem[] = [
    ...(linked && !m.githubVerified ? [{ label: "Approve GitHub link", icon: "check" as const, onSelect: onApprove, disabled: pending }] : []),
    ...(linked ? [{ label: "Remove GitHub link", icon: "github" as const, bad: true, onSelect: onUnlink, disabled: pending }] : []),
    ...(lastAdmin ? [] : [{ label: "Remove from team", icon: "trash" as const, bad: true, onSelect: onRemove, disabled: pending }]),
  ];
  const chipTip = self ? (lastAdmin ? LAST_ADMIN : "You cannot change your own role") : canManage ? undefined : "Only admins change roles";
  const reasonId = useId();
  return (
    <li className="set-tm-row">
      <Avatar url={m.avatarUrl} size={32} />
      <span className="two set-tm-main">
        <span className="two-main set-tm-title">
          <span className="set-tm-name">
            {m.name}
          </span>
          {self ? <Chip size="xs">You</Chip> : null}
          {m.githubLogin ? <GitHubLink login={m.githubLogin} verified={m.githubVerified} /> : null}
        </span>
        <span className="two-sub set-tm-sub">
          <span className="set-tm-email">{m.email}</span>
          <span className="set-keep">
            , <When iso={m.joinedAt} now={now} prefix="joined" />
          </span>
        </span>
      </span>
      <span className="set-tm-role">
        {pick ? (
          <span className="set-tm-pick" data-tip={lastAdmin ? LAST_ADMIN : undefined} data-tip-align="end">
            <Select
              size="sm"
              align="end"
              label={`Role for ${m.name}`}
              value={m.role}
              // While a change saves the trigger keeps the focus; a pick in that moment is ignored.
              onChange={(r) => {
                if (!pending) onRole(r);
              }}
              disabled={lastAdmin}
              options={ROLE_OPTIONS.map((o) => ({ ...o, disabled: lastAdmin && o.value === "viewer" }))}
            />
          </span>
        ) : (
          <span className="set-readonly" data-tip={chipTip} data-tip-align="end">
            {ROLE_LABEL[m.role]}
          </span>
        )}
      </span>
      <span className="set-tm-end">
        {!pick ? null : !items.length ? (
          <>
            {/* Focusable though it cannot be used, so its tip gives the reason to the pointer and the keyboard. */}
            <button type="button" className="btn btn-xs btn-icon" aria-disabled="true" aria-label={`More for ${m.name}`} aria-describedby={reasonId} data-tip={LAST_ADMIN} data-tip-align="end">
              <Icon name="more" />
            </button>
            <span id={reasonId} className="sr">
              {LAST_ADMIN}
            </span>
          </>
        ) : (
          <RowMenu label={`More for ${m.name}`} items={items} />
        )}
      </span>
    </li>
  );
}

/** The raw link is never stored, so New link mints a fresh one and the previous link stops working. */
function InviteRow({
  inv,
  now,
  canManage,
  emailEnabled,
  onFresh,
  onResend,
  onRevoke,
}: {
  inv: Invite;
  now: number;
  canManage: boolean;
  emailEnabled: boolean;
  onFresh: () => Promise<string>;
  onResend: () => void;
  onRevoke: () => void;
}) {
  return (
    <li className="set-tm-row">
      <Avatar size={32} />
      <span className="two set-tm-main">
        <span className="two-main set-tm-title">
          <span className="set-tm-name">
            {inv.email}
          </span>
          {inv.emailStatus === "failed" ? (
            <Chip size="xs" tone="bad">
              Email failed
            </Chip>
          ) : (
            <Chip size="xs" tone="pending">
              Pending
            </Chip>
          )}
        </span>
        <span className="two-sub set-tm-sub">
          <span>{ROLE_LABEL[inv.role]}</span>
          <span className="set-keep">
            , <Until iso={inv.expiresAt} now={now} prefix="expires" expired="expired" />
          </span>
          {inv.emailStatus === "failed" && inv.emailError ? <span>. {inv.emailError}</span> : null}
        </span>
      </span>
      <span className="set-tm-role">
        {canManage ? (
          <span className="set-tm-copy">
            <CopyTextButton value={onFresh} label="New link" size="sm" />
          </span>
        ) : null}
      </span>
      <span className="set-tm-end">
        {canManage ? (
          <RowMenu
            label={`More for ${inv.email}`}
            items={[
              ...(emailEnabled ? [{ label: "Resend email", icon: "mail" as const, onSelect: onResend }] : []),
              { label: "Revoke invite", icon: "trash", bad: true, onSelect: onRevoke },
            ]}
          />
        ) : null}
      </span>
    </li>
  );
}

/** Mounted only while open, so every opening starts clean and a one-time link never lingers after Done. */
function InviteDialog({
  onClose,
  onCreated,
  preview,
  emailEnabled,
  elevate,
}: {
  onClose: () => void;
  onCreated: (inv: Invite) => void;
  preview: boolean;
  emailEnabled: boolean;
  elevate: Elevate;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [send, setSend] = useState(true);
  const [emailed, setEmailed] = useState(false);

  const mailing = emailEnabled && send;

  const submit = async () => {
    if (busy || url) return;
    if (!email.trim()) return setError("Enter an email address");
    setBusy(true);
    const res = await settle(elevate(() => createInvite({ email, role, send: mailing }), { what: "Inviting a member" }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const who = `${res.data.invite.email}, ${ROLE_LABEL[res.data.invite.role]}`;
    if (res.data.emailed) toast.success("Invite email queued", { description: describe([who, "The team list shows if it fails. The copy link works too"], { preview }) });
    else toast.success("Invite link created", { description: describe(who, { preview }) });
    setEmailed(res.data.emailed);
    setUrl(res.data.url);
    onCreated(res.data.invite);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      size="sm"
      icon="userPlus"
      title={url ? (emailed ? "Invite created" : "Share this invite link") : "Invite member"}
      sub={url ? email.trim() : undefined}
      onSubmit={() => void submit()}
      footer={
        url ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            <Icon name="check" />
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <PendingButton type="submit" className="btn btn-primary" pending={busy} icon={mailing ? "mail" : "link"}>
              {mailing ? "Send invite" : "Create invite link"}
            </PendingButton>
          </>
        )
      }
    >
      {url ? (
        <>
          <p className="dlg-text">
            {emailed
              ? `The email is queued, and the team list shows if it fails. You can also share this link yourself. It works once and expires in 7 days.`
              : `Send this link yourself, in chat or however you talk. It works once and expires in 7 days.`}
          </p>
          <div className="fld">
            <span className="fld-label">Invite link</span>
            <CopyBox value={url} what="invite link" />
            <p className="fld-note">You can revoke it from the team list until it is used.</p>
          </div>
        </>
      ) : (
        <>
          <Field label="Email" error={error}>
            {(ids) => (
              <TextInput
                ids={ids}
                type="email"
                value={email}
                placeholder="name@company.com"
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                data-autofocus
              />
            )}
          </Field>
          <Field label="Role" hint={ROLE_HINT[role]}>
            {(ids) => <Select ids={ids} label="Role" value={role} onChange={setRole} options={ROLE_OPTIONS} />}
          </Field>
          {emailEnabled ? (
            <label className="set-tm-check">
              <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
              <span className="two">
                <span className="two-main">Send invite email</span>
                <span className="two-sub">You get the one-time link to copy either way.</span>
              </span>
            </label>
          ) : (
            <Callout tone="info">Email is not set up, so you get a one-time link to copy and share yourself after creating.</Callout>
          )}
        </>
      )}
    </Dialog>
  );
}

export function TeamSection({ data, update, onDirty, now, preview, emailEnabled, elevate, tab, onTab }: SectionProps) {
  const { members, invites } = data.team;
  const canManage = data.me.role === "admin";
  const admins = members.filter((m) => m.role === "admin").length;
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const [unlinking, setUnlinking] = useState<TeamMember | null>(null);

  // Everything here acts at once: never mark the section dirty.
  useEffect(() => onDirty(false), [onDirty]);

  // Counts the writes shown here, so a team read that left before one is not applied over it.
  const writes = useRef(0);
  const setTeam = (team: SettingsData["team"]) => {
    writes.current += 1;
    update({ team });
  };

  // An emailed invite stays queued until the worker settles it, so the list is read again until none is.
  const queued = invites.filter((i) => i.emailStatus === "queued").map((i) => i.id).join(",");
  const follow = useEffectEvent(async () => {
    if (document.hidden || busy) return;
    const at = writes.current;
    const fresh = await settle(readTeam());
    if (fresh.ok && fresh.data && at === writes.current) update({ team: fresh.data });
  });
  useEffect(() => {
    if (!queued || preview) return;
    let polls = 0;
    const t = setInterval(() => {
      polls += 1;
      if (polls > INVITE_POLLS) return clearInterval(t);
      void follow();
    }, INVITE_POLL_MS);
    return () => clearInterval(t);
  }, [queued, preview]);

  // Optimistic: the pick shows at once and rolls back with an error toast if the API refuses.
  const changeRole = async (m: TeamMember, role: TeamRole) => {
    if (busy || role === m.role) return;
    const before = data.team;
    setBusy(m.id);
    setTeam({ ...before, members: before.members.map((x) => (x.id === m.id ? { ...x, role } : x)) });
    const change: TeamChange[] = [{ id: m.id, role }];
    const res = report(await settle(elevate(() => saveTeam(change), { what: "Changing a role" })), { success: "Role changed", error: "Could not change the role", what: `${m.name}, now ${ROLE_LABEL[role]}`, preview });
    setBusy(null);
    setTeam(res.ok ? res.data : before);
  };

  const remove = async () => {
    if (!removing) return;
    const m = removing;
    const res = report(await settle(elevate(() => saveTeam([{ id: m.id, remove: true }]), { what: "Removing a member" })), { success: "Member removed", error: "Could not remove the member", what: m.name, preview });
    if (!res.ok) throw new Error(res.error);
    setTeam(res.data);
    // The member's API tokens were deleted with the account: the Tokens section reads its list again.
    const tokens = await settle(readTokens());
    if (tokens.ok && tokens.data) update({ tokens: tokens.data });
  };

  const approve = async (m: TeamMember) => {
    if (busy) return;
    setBusy(m.id);
    const res = report(await settle(elevate(() => saveTeam([{ id: m.id, githubVerified: true }]), { what: "Approving a GitHub link" })), {
      success: "GitHub link approved",
      error: "Could not approve the GitHub link",
      what: `${m.name}, ${m.githubLogin}`,
      preview,
    });
    setBusy(null);
    if (res.ok) setTeam(res.data);
  };

  const unlink = async () => {
    if (!unlinking?.githubLogin) return;
    const m = unlinking;
    const res = report(await settle(elevate(() => saveTeam([{ id: m.id, githubLogin: null }]), { what: "Removing a GitHub link" })), {
      success: "GitHub link removed",
      error: "Could not remove the GitHub link",
      what: `${m.name}, ${m.githubLogin}`,
      preview,
    });
    if (!res.ok) throw new Error(res.error);
    setTeam(res.data);
  };

  const revoke = async () => {
    if (!revoking) return;
    const inv = revoking;
    const res = report(await settle(elevate(() => revokeInvite(inv.id), { what: "Revoking an invite" })), { success: "Invite revoked", error: "Could not revoke the invite", what: inv.email, preview });
    if (!res.ok) throw new Error(res.error);
    setTeam({ members, invites: invites.filter((i) => i.id !== inv.id) });
  };

  // A new invite for the same address replaces the old one (the API revokes it), here too.
  const replaced = (inv: Invite) => setTeam({ members, invites: [inv, ...invites.filter((i) => i.email !== inv.email)] });

  const fresh = async (inv: Invite): Promise<string> => {
    const res = await settle(elevate(() => createInvite({ email: inv.email, role: inv.role, send: false }), { what: "Making a new invite link" }));
    if (!res.ok) {
      toast.error("Could not make a new link", { description: describe([inv.email, res.error], { preview }) });
      throw new Error(res.error);
    }
    replaced(res.data.invite);
    toast.success("New invite link copied", { description: describe([inv.email, "The previous link stopped working"], { preview }) });
    return res.data.url;
  };

  const resend = async (inv: Invite) => {
    const p = elevate(() => createInvite({ email: inv.email, role: inv.role, send: true }), { what: "Sending the invite again" }).then((res) => {
      if (!res.ok) throw new Error(res.error);
      if (!res.data.emailed) throw new Error("Email did not go out. Copy the link instead");
      replaced(res.data.invite);
      return res;
    });
    void toast
      .promise(p, {
        loading: "Sending invite",
        success: () => ({ title: "Invite email queued", description: describe([inv.email, "The previous link stopped working"], { preview }) }),
        error: (e: unknown) => ({ title: "Could not resend the invite", description: errText(e) }),
      })
      .catch(() => undefined);
  };

  const invite = (
    <button type="button" className="btn btn-sm btn-primary" onClick={() => setInviting(true)}>
      <Icon name="plus" />
      Invite member
    </button>
  );

  return (
    <>
      <SectionTabs section="team" tab={tab} onTab={onTab} counts={{ members: members.length, invites: invites.length }}>
        <Segment value="members" tab={tab}>
          <Group
            id="set-team"
            icon="users"
            title="Members"
            sub={`${members.length} ${members.length === 1 ? "person" : "people"} can sign in, ${admins} ${admins === 1 ? "admin" : "admins"}`}
            actions={canManage ? invite : null}
          >
            <ul className="set-tm-list" aria-label="Members">
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  m={m}
                  now={now}
                  self={m.id === data.me.id}
                  canManage={canManage}
                  lastAdmin={m.role === "admin" && admins <= 1}
                  pending={busy === m.id}
                  onRole={(role) => void changeRole(m, role)}
                  onRemove={() => setRemoving(m)}
                  onApprove={() => void approve(m)}
                  onUnlink={() => setUnlinking(m)}
                />
              ))}
            </ul>
          </Group>
        </Segment>
        <Segment value="invites" tab={tab}>
          <Group id="set-invites" icon="mail" title="Pending invites" sub="Sent by email when email is set up, or share the one-time link" actions={canManage ? invite : null}>
            {invites.length ? (
              <ul className="set-tm-list" aria-label="Pending invites">
                {invites.map((inv) => (
                  <InviteRow
                    key={inv.id}
                    inv={inv}
                    now={now}
                    canManage={canManage}
                    emailEnabled={emailEnabled}
                    onFresh={() => fresh(inv)}
                    onResend={() => void resend(inv)}
                    onRevoke={() => setRevoking(inv)}
                  />
                ))}
              </ul>
            ) : (
              <Empty
                size="sm"
                icon="mail"
                title="No pending invites"
                body={canManage ? "Invite someone and the link waits here until it is used." : "An admin can invite people."}
              />
            )}
          </Group>
        </Segment>
      </SectionTabs>
      {inviting ? <InviteDialog onClose={() => setInviting(false)} onCreated={replaced} preview={preview} emailEnabled={emailEnabled} elevate={elevate} /> : null}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        tone="danger"
        title="Remove from team"
        sub={removing?.email}
        body={`${removing?.name ?? "This member"} loses access at once. Their account, sessions and API tokens are deleted. This cannot be undone.`}
        confirmLabel="Remove member"
        confirmIcon="trash"
        confirmText={removing?.name}
        returnFocus={() => document.getElementById("set-team")}
      />
      <ConfirmDialog
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        onConfirm={unlink}
        tone="danger"
        title="Remove GitHub link"
        sub={unlinking?.name}
        body={`${unlinking?.githubLogin ?? "The login"} is no longer linked to ${unlinking?.name ?? "this member"}. Their pushes will show as a GitHub author instead.`}
        confirmLabel="Remove GitHub link"
        confirmIcon="github"
      />
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        tone="danger"
        title="Revoke invite"
        body={`The link for ${revoking?.email ?? "this invite"} stops working at once.`}
        confirmLabel="Revoke invite"
        confirmIcon="trash"
        returnFocus={() => document.getElementById("set-invites")}
      />
    </>
  );
}
