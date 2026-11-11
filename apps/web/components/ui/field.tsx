"use client";

import { useId, useRef } from "react";
import { Icon } from "@/components/icon";
import { useSlashFocus } from "@/lib/hooks";
import { cx } from "./cx";
import { useSingleKeyShortcuts } from "./shortcuts";

// Controls that are not text inputs take the same `ids`: Select, DateTimePicker, Switch and
// Segmented put the hint or error on aria-describedby and the error on aria-invalid.

/** Wiring a Field hands to its control: the id its label points at, the label's own id, the note id, the invalid flag. */
export interface FieldIds {
  id: string;
  /** The visible label's id, for a control a <label for> cannot name (a radio group) or names only in part (a Select and its value). */
  labelId?: string;
  describedBy?: string;
  invalid: boolean;
}

/** The error replaces the hint and is announced. `children` is a render prop that receives the ids, or a plain node that wires itself. */
export function Field({
  label,
  hint,
  error,
  id,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  /** Fixed control id; generated when left out. */
  id?: string;
  className?: string;
  children: ((ids: FieldIds) => React.ReactNode) | React.ReactNode;
}) {
  const auto = useId();
  const ctl = id ?? auto;
  const note = `${ctl}-note`;
  const labelId = `${ctl}-label`;
  const ids: FieldIds = { id: ctl, labelId, describedBy: hint || error ? note : undefined, invalid: Boolean(error) };
  return (
    <div className={cx("fld", className)} data-invalid={ids.invalid || undefined}>
      <label id={labelId} htmlFor={ctl} className="fld-label">
        {label}
      </label>
      {typeof children === "function" ? children(ids) : children}
      {error ? (
        <p id={note} className="fld-note fld-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={note} className="fld-note">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type Wired = { ids?: FieldIds; invalid?: boolean };

/** Spread `ids` from a Field, or set `id` and `invalid` yourself. */
export function TextInput({ ids, invalid, className, ...rest }: React.ComponentProps<"input"> & Wired) {
  const bad = invalid ?? ids?.invalid;
  return (
    <input spellCheck={false}
      id={ids?.id}
      aria-describedby={ids?.describedBy}
      {...rest}
      aria-invalid={bad || undefined}
      className={cx("field", className)}
    />
  );
}

export function TextArea({ ids, invalid, className, rows = 4, ...rest }: React.ComponentProps<"textarea"> & Wired) {
  const bad = invalid ?? ids?.invalid;
  return (
    <textarea spellCheck={false}
      id={ids?.id}
      aria-describedby={ids?.describedBy}
      rows={rows}
      {...rest}
      aria-invalid={bad || undefined}
      className={cx("field field-area", className)}
    />
  );
}

// Esc clears the query and keeps the focus; an Esc in an empty field is left to whatever holds it.
// Extras and the clear key sit beside the input, never inside a <label>, so they do not join its name.
export function SearchField({
  value,
  onChange,
  label,
  placeholder = "Search",
  slash = true,
  inputRef,
  className,
  id,
  invalid,
  describedBy,
  onKeyDown,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Accessible name, read by screen readers only. */
  label: string;
  placeholder?: string;
  /** "/" focuses this field. Turn it off for a second search on the same page. */
  slash?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
  id?: string;
  /** The query cannot be used (a bad regular expression): the field takes the red ring. */
  invalid?: boolean;
  /** Id of a note read with the field, such as the "3 of 12" match count. */
  describedBy?: string;
  /** Esc stays owned by the field. */
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  /** Inline extras at the right, before the clear key, such as a match count. */
  children?: React.ReactNode;
}) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  const [shortcuts] = useSingleKeyShortcuts();
  const slashOn = slash && shortcuts;
  useSlashFocus(ref, slashOn);

  return (
    <div
      className={cx("search", className)}
      // The whole box is the field: a press on its glyph or padding puts the caret in the input.
      onMouseDown={(e) => {
        const t = e.target as Element;
        if (t === ref.current || t.closest("button, a, input")) return;
        e.preventDefault();
        ref.current?.focus();
      }}
    >
      <Icon name="search" />
      <input
        ref={ref}
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") {
            onKeyDown?.(e);
            return;
          }
          if (!value) return;
          // Used here, so a dialog around the field does not also close on this Esc.
          e.preventDefault();
          e.stopPropagation();
          onChange("");
        }}
      />
      {children}
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          data-tip="Clear, Esc"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <Icon name="close" size={12} />
        </button>
      ) : slashOn ? (
        <kbd className="kbd" aria-hidden="true">
          /
        </kbd>
      ) : null}
    </div>
  );
}
