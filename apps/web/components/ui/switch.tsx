"use client";

import { cx } from "./cx";
import type { FieldIds } from "./field";

/**
 * The one on/off toggle. 36 by 20 track: off is the soft grey track inside a 3:1 ring, on is solid
 * blue; the white knob slides 16px. Keyboard: Space or Enter (native button). Inside a Field pass
 * `ids`, so the label names it and the hint or error is read with it.
 */
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
  /** From a Field: the id its label points at, the hint or error, the invalid flag. */
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
