"use client";

import { Select } from "@/components/ui/select";
import type { GitInstallation } from "@/lib/pages/git";

const ADD = "__add";

/** "Add GitHub account" at the bottom starts a new install instead of picking. */
export function AccountSelect({
  installations,
  value,
  onChange,
  onAdd,
  disabled,
}: {
  installations: GitInstallation[];
  value: string | null;
  onChange: (id: string) => void;
  onAdd: () => void;
  disabled?: boolean;
}) {
  return (
    <Select
      className="git-account"
      label="GitHub account"
      value={value}
      disabled={disabled}
      placeholder="Choose an account"
      onChange={(v) => (v === ADD ? onAdd() : onChange(v))}
      options={[
        ...installations.map((i) => ({
          value: i.id,
          label: i.account.login,
          icon: i.account.type === "Organization" ? ("org" as const) : ("user" as const),
        })),
        { value: ADD, label: "Add GitHub account", icon: "plus" as const },
      ]}
    />
  );
}
