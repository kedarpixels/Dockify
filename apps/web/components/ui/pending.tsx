import { Icon, type IconName } from "@/components/icon";

/*
 * Keys that start async work.
 *
 *   <PendingButton className="btn btn-primary" pending={busy} icon="deploy" onClick={deploy}>Deploy</PendingButton>
 *   <PendingButton type="submit" className="btn btn-primary" pending={saving}>Save</PendingButton>
 *
 * While pending the key is aria-disabled and aria-busy, never `disabled`: a disabled key drops the
 * focus to the page the moment it is pressed, so a keyboard or screen reader user would lose their
 * place and miss the result. Presses are ignored until it settles, and it reads dimmed the way a
 * disabled key does. A `disabled` passed to PendingButton is drawn the same way (aria-disabled,
 * presses ignored, a submit key does not submit), so a key that becomes unavailable once its own
 * work is done (Save on a form that is now clean) keeps the focus too.
 *
 * PendingLabel is its content, for a key that cannot be a PendingButton (a Link-shaped key):
 * the key keeps its width while pending. With `icon`, the icon leads and turns into the spinning
 * loader (primary CTAs, `btn-lead`, icon-only keys). With `trailing`, the glyph follows the label
 * and turns into the loader in its place: the arrow of a key that moves on to the next step
 * ("Continue"). Without either, the label stays in place but invisible and the loader sits centred
 * over it (text only buttons). The label stays in the accessibility tree, so the key keeps its name.
 */
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

/**
 * A key that runs async work and keeps the focus while it does: aria-disabled and aria-busy while
 * `pending`, aria-disabled while `disabled`, presses ignored either way (a submit key does not
 * submit), the label from PendingLabel.
 */
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
