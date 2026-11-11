import { CopyButton } from "./copy-button";
import { cx } from "./cx";

/** The value wraps (never an ellipsis) and selects whole on a click. `code` spaces the characters for values typed by hand. */
export function CopyBox({
  value,
  what,
  code,
  id,
  className,
}: {
  value: string;
  /** Names the value for the copy key: "Copy invite link". */
  what: string;
  code?: boolean;
  /** For a label or note that points at the value. */
  id?: string;
  className?: string;
}) {
  return (
    <div className={cx("copy-box", className)} data-code={code || undefined}>
      <p id={id} className="copy-box-value num">
        {value}
      </p>
      <CopyButton value={value} what={what} align="end" />
    </div>
  );
}
