"use client";

import { cx } from "./cx";
import type { FieldIds } from "./field";

/** Inside a Field pass `ids`, so the label names it and the hint or error is read with it. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
  ids,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name when no visible <label htmlFor={id}> sits next to it. */
  label?: string;
  disabled?: boolean;
  id?: string;
  ids?: FieldIds;
  className?: string;
}) {
  return (
    <button
      id={id ?? ids?.id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={ids?.describedBy}
      aria-invalid={ids?.invalid || undefined}
      disabled={disabled}
      className={cx("switch", className)}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}
