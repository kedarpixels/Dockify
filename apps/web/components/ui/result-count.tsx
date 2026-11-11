"use client";

import { useEffect, useState } from "react";

/** For screen readers only, once the typing settles (500ms): the list itself changes silently otherwise. */
export function ResultCount({
  count,
  one,
  many = `${one}s`,
  query,
  delay = 500,
}: {
  count: number;
  one: string;
  many?: string;
  /** The search text; an empty result names it ("No projects match lig"). */
  query?: string;
  delay?: number;
}) {
  const text = count === 0 ? (query?.trim() ? `No ${many} match ${query.trim()}` : `No ${many}`) : `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
  const [said, setSaid] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSaid(text), delay);
    return () => clearTimeout(t);
  }, [text, delay]);
  return (
    <span className="sr" role="status">
      {said}
    </span>
  );
}
