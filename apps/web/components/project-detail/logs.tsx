"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { CopyButton } from "@/components/ui/copy-button";
import { Empty } from "@/components/ui/empty";
import { SearchField } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { ResultCount } from "@/components/ui/result-count";
import { Rule } from "@/components/ui/rule";
import { filterOptions, Segmented } from "@/components/ui/segmented";
import { downloadText } from "@/lib/download";
import { clause, plural } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import { useTimeFormat } from "@/lib/time-prefs";
import type { LogLine } from "@/lib/pages/project-detail";
import type { AppStatus } from "@/lib/types";
import { notRunning } from "@/lib/derive";

/* Deliberately simple: the full log viewer lives with the deployments pages. */

export function LogPanel({ lines, error, status, name }: { lines: LogLine[] | null; error?: string; status: AppStatus; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [stream, setStream] = useState<"all" | "stderr">("all");
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const hydrated = useHydrated();
  const time = useTimeFormat();
  // Browser-local times wait for mount, so the server render agrees; a picked zone does not.
  const utc = !hydrated && !time.prefs.timeZone;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (lines ?? []).filter((l) => (stream === "all" || l.stream === "stderr") && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, stream, query]);

  const errors = lines?.filter((l) => l.stream === "stderr").length ?? 0;
  const asText = () => shown.map((l) => `${l.at} ${l.stream} ${l.text}`).join("\n") + "\n";

  const download = () => downloadText(`${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`, asText());

  // Newest lines are at the bottom, so open scrolled to the end, again after a refresh, and when
  // the box comes back after a filter matched nothing.
  const none = shown.length === 0;
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, stream, none]);

  const q = query.trim();

  return (
    <section className="card" aria-labelledby="pd-log-title">
      <div className="card-hd">
        <CardTitle id="pd-log-title" icon="logs" title="Runtime logs" sub={lines?.length ? `Last ${plural(lines.length, "line")}, ${errors} on stderr` : "Container output"} />
        <span className="pd-hd-acts">
          {lines?.length ? (
            <>
              <CopyButton value={() => Promise.resolve(asText())} what="shown lines" size="sm" disabled={!shown.length} />
              <button type="button" className="btn btn-sm btn-lead" disabled={!shown.length} onClick={download}>
                <Icon name="download" />
                Download
              </button>
            </>
          ) : null}
          <PendingButton className="btn btn-sm" pending={pending} onClick={() => start(() => router.refresh())}>
            Refresh
          </PendingButton>
        </span>
      </div>

      {!lines ? (
        <Empty icon="server" title="Logs are unavailable" body={error ? `${clause(error)}. Refresh to try again.` : "The Dockify API did not return logs for this app."} />
      ) : lines.length === 0 ? (
        <Empty icon="box" title={notRunning(status) ? "Not running" : "No output yet"} body={notRunning(status) ? "Start the app to see what it writes to stdout and stderr." : "Lines appear here as soon as the container writes to stdout or stderr."} />
      ) : (
        <>
          <div className="toolbar">
            <SearchField value={query} onChange={setQuery} label="Search logs" placeholder="Search lines" />
            <Segmented
              label="Stream"
              value={stream}
              onChange={setStream}
              options={filterOptions<"all" | "stderr">([
                { value: "all", label: "All", count: lines.length },
                { value: "stderr", label: "Errors", tone: "bad", count: errors },
              ])}
            />
            <ResultCount count={shown.length} one="line" query={q} />
          </div>
          <Rule />
          {none ? (
            <Empty
              icon="search"
              title="No log lines match"
              body={q ? `Nothing matches “${q}”. Try another word from the line.` : "No line is on stderr right now."}
              action={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setQuery("");
                    setStream("all");
                  }}
                >
                  {stream !== "all" ? "Clear filters" : "Clear search"}
                </button>
              }
            />
          ) : (
            <div ref={box} className="pd-log" role="log" aria-live="off" aria-busy={pending} tabIndex={0} aria-label="Log lines">
              {shown.map((l, i) => (
                <div key={`${l.at}-${i}`} className="pd-log-line" data-stream={l.stream}>
                  <span className="pd-log-at num">{time.clock(l.at, { utc, seconds: true })}</span>
                  <span className="pd-log-text">{l.text}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
