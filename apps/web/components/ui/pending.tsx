import { Icon, type IconName } from "@/components/icon";

// While pending the key is aria-disabled and aria-busy, never `disabled`: a disabled key drops the
// focus to the page the moment it is pressed. The label stays in the accessibility tree.
export function PendingLabel({
  pending,
  icon,
  trailing,
  children,
}: {
  pending: boolean;
  icon?: IconName;
  trailing?: IconName;
  children?: React.ReactNode;
}) {
  if (icon) {
    return (
      <>
        <Icon name={pending ? "loader" : icon} size={16} className={pending ? "spin" : undefined} />
        {children}
      </>
    );
  }
  if (trailing) {
    return (
      <>
        {children}
        <Icon name={pending ? "loader" : trailing} size={16} className={pending ? "ic-trail spin" : "ic-trail"} />
      </>
    );
  }
  return (
    <>
      <span className="pend-label" data-pending={pending || undefined}>
        {children}
      </span>
      {pending ? (
        <span className="pend-spin" aria-hidden="true">
          <Icon name="loader" size={16} className="spin" />
        </span>
      ) : null}
    </>
  );
}

/** A `disabled` passed here is drawn as aria-disabled too, so a key that turns unavailable keeps the focus. */
export function PendingButton({
  pending,
  icon,
  trailing,
  type = "button",
  disabled,
  onClick,
  children,
  ...rest
}: Omit<React.ComponentProps<"button">, "aria-disabled" | "aria-busy"> & {
  pending: boolean;
  icon?: IconName;
  trailing?: IconName;
}) {
  const off = pending || Boolean(disabled);
  return (
    <button
      {...rest}
      type={type}
      aria-disabled={off || undefined}
      aria-busy={pending || undefined}
      onClick={(e) => {
        if (off) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      <PendingLabel pending={pending} icon={icon} trailing={trailing}>
        {children}
      </PendingLabel>
    </button>
  );
}
