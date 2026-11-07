"use client";

import { useEffect, useRef, useState } from "react";
import { plural } from "@/lib/format";

/*
 * What a streaming log says to screen readers. A log prints far faster than speech, so the log box
 * itself stays out of the live region (role="log" with aria-live="off") and this one polite status
 * sums it up instead, at most once every `every` ms: "12 new lines". A `message` (a deployment that
 * just turned ready or failed) is said as soon as it changes. Nothing is said on the first render:
 * the page was just read.
 *
 *   <LogAnnouncer count={lines.length} active={live} message={outcome} />
 */
export function LogAnnouncer({
  count,
  active,
  message = null,
  every = 10_000,
}: {
  /** Lines shown so far; it only grows while the same log streams, and a drop starts a new count. */
  count: number;
  /** The log is streaming: only then are new lines summed up. */
  active: boolean;
  /** A change worth hearing at once, such as "Deployment ready". */
  message?: string | null;
  every?: number;
}) {
  // Each new sentence gets a new key, so the same words twice in a row are still read.
  const [said, setSaid] = useState({ n: 0, text: "" });
  const [heard, setHeard] = useState(message);
  if (message !== heard) {
    setHeard(message);
    if (message) setSaid((s) => ({ n: s.n + 1, text: message }));
  }

  const latest = useRef(count);
  const told = useRef(count);
  useEffect(() => {
    latest.current = count;
    // A shorter log is another log (new filters, a fresh load): count from here.
    if (count < told.current) told.current = count;
  }, [count]);

  useEffect(() => {
    if (!active) return;
    told.current = latest.current;
    const id = setInterval(() => {
      const fresh = latest.current - told.current;
      if (fresh <= 0) return;
      told.current = latest.current;
      setSaid((s) => ({ n: s.n + 1, text: plural(fresh, "new line") }));
    }, every);
    return () => clearInterval(id);
  }, [active, every]);

  return (
    <span className="sr" role="status">
      <span key={said.n}>{said.text}</span>
    </span>
  );
}
