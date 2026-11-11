"use client";

import { useEffect, useRef, useState } from "react";
import { updateProfile } from "@/app/(console)/settings/actions";
import { Icon } from "@/components/icon";
import { Avatar } from "@/components/ui/avatar";
import { Chip } from "@/components/ui/chip";
import { TextInput } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { describe } from "@/lib/feedback";
import { EmailCodeDialog } from "./email-code-dialog";
import { Group, SaveBar, settle, SettingRow } from "./form";
import type { SectionProps } from "./settings-view";
import { displayNameProblem } from "@/lib/validation";

const MAX_BYTES = 1024 * 1024;

/** With email configured, a new address is confirmed by a code sent to it. */
export function ProfileSection({ data, update, onDirty, preview, go, emailEnabled, elevate }: SectionProps) {
  const me = data.me;
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email);
  // undefined: unchanged; string: a new picture as a data URL. A picture is only ever replaced, never removed.
  const [avatar, setAvatar] = useState<string | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [coding, setCoding] = useState<{ target?: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  // The file being read; a discard or a newer pick makes an older read land nowhere.
  const reading = useRef<FileReader | null>(null);

  const shown = avatar ?? me.avatarUrl;
  const nameError = displayNameProblem(name, { empty: "Name cannot be empty" });
  const emailError = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : "Enter a valid email address";
  // Picking the picture that is already saved is no change at all.
  const pictureChanged = avatar !== undefined && avatar !== me.avatarUrl;
  const dirty = name !== me.name || email !== me.email || pictureChanged;
  const invalid = nameError || emailError;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const pick = (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return setFileError("Use a PNG, JPG, WebP or GIF image");
    if (f.size > MAX_BYTES) return setFileError("Pick an image under 1 MB");
    const reader = new FileReader();
    reading.current = reader;
    reader.onload = () => {
      if (reading.current === reader) setAvatar(String(reader.result));
    };
    reader.onerror = () => {
      if (reading.current === reader) setFileError("That file could not be read");
    };
    reader.readAsDataURL(f);
  };

  const discard = () => {
    reading.current = null;
    setName(me.name);
    setEmail(me.email);
    setAvatar(undefined);
    setFileError(null);
    setError(null);
  };

  const fail = (title: string, message: string) => {
    toast.error(title, { description: message });
    setSaving(false);
  };

  const save = async () => {
    if (invalid) return setError("Fix the highlighted fields first");
    setError(null);
    setSaving(true);
    const nextEmail = email.trim().toLowerCase();
    // With email on, the address moves only through its code; the rest saves as usual first.
    const byCode = emailEnabled && nextEmail !== me.email.toLowerCase();
    const profileChanges = name !== me.name || pictureChanged || (!byCode && email !== me.email);
    const onlyPicture = pictureChanged && name === me.name && (email === me.email || byCode);
    const done: string[] = [];
    let latest = me;

    if (profileChanges) {
      const sent = { name, email: byCode ? me.email : email, avatar: pictureChanged ? avatar : undefined };
      const res = await settle(elevate(() => updateProfile(sent), { what: "Changing your profile" }));
      if (!res.ok) return fail("Could not save profile", res.error);
      latest = res.data;
      // Edits typed while the save ran stay; the rest take the stored values.
      setName((v) => (v === sent.name ? res.data.name : v));
      setEmail((v) => (v === sent.email ? res.data.email : v));
      setAvatar((v) => (v === sent.avatar ? undefined : v));
      if (!onlyPicture) done.push(`${name.trim()}, ${sent.email.trim()}`);
    }

    update({ me: latest });
    setSaving(false);
    if (profileChanges) {
      const title = onlyPicture ? "Picture updated" : "Profile saved";
      toast.success(title, { description: describe(onlyPicture ? `${name.trim()}, ${me.email}` : done.join(", "), { preview }) });
    }
    if (byCode) setCoding({ target: nextEmail });
  };

  const admin = me.role === "admin";

  return (
    <>
      <Group id="set-profile" icon="user" title="Profile" sub="Who you are to your team on this instance">
        {/* No row in this section leads with a tile, so the picture sits with its keys. */}
        <SettingRow label="Picture" desc="PNG, JPG, WebP or GIF, up to 1 MB. Shown round." error={fileError}>
          <Avatar url={shown} size={32} />
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button type="button" className="btn btn-sm btn-lead" onClick={() => file.current?.click()}>
            <Icon name="upload" />
            Upload
          </button>
        </SettingRow>
        <SettingRow label="Name" desc="Shown in the team list and the activity log." error={name !== me.name ? nameError : null}>
          {(ids) => <TextInput ids={ids} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />}
        </SettingRow>
        <SettingRow
          label={
            <>
              Email
              {emailEnabled ? (
                <Chip size="xs" tone={me.emailVerified ? "ok" : "warn"}>
                  {me.emailVerified ? "Verified" : "Not verified"}
                </Chip>
              ) : null}
            </>
          }
          desc={emailEnabled ? "What you sign in with. A new address is confirmed by a code sent to it." : "What you sign in with."}
          error={email !== me.email ? emailError : null}
        >
          {(ids) => {
            const input = <TextInput ids={ids} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} />;
            if (!emailEnabled || me.emailVerified || email !== me.email) return input;
            return (
              <div className="as-inline">
                {input}
                <button type="button" className="btn" onClick={() => setCoding({})}>
                  Verify
                </button>
              </div>
            );
          }}
        </SettingRow>
        <SettingRow
          label="Role"
          desc={
            admin ? (
              <>
                You can change roles in{" "}
                <button type="button" className="set-inline-link" onClick={() => go("team")}>
                  Team
                </button>
              </>
            ) : (
              "Changed by an admin in Team"
            )
          }
        >
          <span className="set-readonly">{admin ? "Admin" : "Viewer"}</span>
        </SettingRow>
      </Group>
      {coding !== null ? (
        <EmailCodeDialog
          onClose={() => setCoding(null)}
          me={me}
          target={coding.target}
          preview={preview}
          onDone={(next) => {
            update({ me: next });
            setEmail((v) => (v.trim().toLowerCase() === next.email ? next.email : v));
            setCoding(null);
          }}
        />
      ) : null}
      <SaveBar dirty={dirty} saving={saving} error={invalid ? error : null} onDiscard={discard} onSave={() => void save()} />
    </>
  );
}
