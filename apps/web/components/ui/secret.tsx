"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { errText } from "@/lib/feedback";
import { CopyButton } from "./copy-button";
import { cx } from "./cx";
import { toast } from "./toast";

// The eye key is a toggle with one name, "Show DATABASE_URL", and aria-pressed for its state, so
// it never reads as "Hide DATABASE_URL, pressed".

/** A fixed width whatever the value's length, so rows never shift. */
export function MaskDots({ className }: { className?: string }) {
  return (
    <span className={cx("mask", className)} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

export function Secret({
  value,
  what,
  onReveal,
  mask,
  copy = true,
  align,
  className,
}: {
  /** The plain value when the page already holds it. */
  value?: string;
  /** Names the value in key labels: "Show DATABASE_URL". */
  what: string;
  /** Fetches the value on the first reveal or copy when `value` is not loaded. */
  onReveal?: () => Promise<string>;
  mask?: React.ReactNode;
  copy?: boolean;
  /** Tip alignment for keys at a row's right edge. */
  align?: "end";
  className?: string;
}) {
  const [shown, setShown] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inflight = useRef<Promise<string> | null>(null);
  const plain = value ?? fetched;

  // One request at a time; a reveal and a copy pressed together share it.
  const load = (): Promise<string> => {
    if (plain !== null) return Promise.resolve(plain);
    if (!onReveal) return Promise.reject(new Error("Nothing to reveal"));
    inflight.current ??= onReveal()
      .then((v) => {
        setFetched(v);
        return v;
      })
      .finally(() => {
        inflight.current = null;
      });
    return inflight.current;
  };

  const toggle = async () => {
    if (pending) return;
    if (shown) return setShown(false);
    if (plain !== null) return setShown(true);
    setPending(true);
    try {
      await load();
      setShown(true);
    } catch (e) {
      toast.error(`Could not reveal ${what}`, { description: errText(e) });
    } finally {
      setPending(false);
    }
  };

  const name = `Show ${what}`;
  const canReveal = plain !== null || Boolean(onReveal);

  return (
    <span className={cx("secret", className)}>
      <span className="secret-value num" data-masked={!shown || undefined}>
        {shown && plain !== null ? plain : (mask ?? <MaskDots />)}
      </span>
      {canReveal ? (
        <button
          type="button"
          className="btn btn-xs btn-icon"
          aria-label={name}
          aria-pressed={shown}
          aria-busy={pending || undefined}
          aria-disabled={pending || undefined}
          onClick={() => void toggle()}
        >
          <Icon name={pending ? "loader" : shown ? "eyeOff" : "eye"} className={pending ? "spin" : undefined} />
        </button>
      ) : null}
      {copy && canReveal ? <CopyButton value={plain ?? load} what={what} align={align} /> : null}
    </span>
  );
}
