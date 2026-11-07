"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";
import { mutate } from "@/components/project-detail/controls";
import { Callout } from "@/components/ui/callout";
import { Empty } from "@/components/ui/empty";
import { PendingButton } from "@/components/ui/pending";
import { Skel } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { notRunning } from "@/lib/derive";
import type { AppDetail } from "@/lib/pages/project-detail";
import { isStepUpCancel, STEP_UP_MINUTES } from "@/lib/step-up";
import { describeClose, TERMINAL_IDLE_MINUTES, TERMINAL_TOTAL_MINUTES, type TerminalEnd } from "@/lib/terminal";
import { TabCard } from "./states";
import type { TerminalHandle, ViewEvent } from "./terminal-view";

/*
 * The app's Terminal tab, for an admin on an app that runs on this server. Viewers never get the tab
 * (app-view.tsx). Opening asks for a ticket, which needs a fresh step-up, so "Confirm it is you"
 * shows first and alone. xterm.js loads only from here, and only once a session starts.
 */

const TerminalView = dynamic(() => import("./terminal-view").then((m) => m.TerminalView), {
  ssr: false,
  loading: () => <Skel w="100%" h="100%" />,
});

type State =
  | { at: "idle" }
  | { at: "asking" }
  | { at: "session"; ticket: string; live: boolean }
  | { at: "ended"; ticket: string | null; end: TerminalEnd };

export function TerminalTab({ app }: { app: AppDetail }) {
  const [state, setState] = useState<State>({ at: "idle" });
  const [copied, setCopied] = useState(false);
  const view = useRef<TerminalHandle>(null);

  const open = useCallback(async () => {
    setState({ at: "asking" });
    const r = await mutate({ type: "app.terminalTicket", id: app.id });
    // Closing "Confirm it is you" opened nothing and is nothing to report.
    if (isStepUpCancel(r)) return setState({ at: "idle" });
    const ticket = (r.data as { ticket?: unknown } | undefined)?.ticket;
    if (!r.ok || typeof ticket !== "string") {
      return setState({ at: "ended", ticket: null, end: { title: "The terminal did not open", body: r.error ?? "The server gave no answer. Try again.", retry: true } });
    }
    setState({ at: "session", ticket, live: false });
  }, [app.id]);

  const onEvent = useCallback((e: ViewEvent) => {
    setState((s) => {
      if (s.at !== "session") return s;
      if (e.type === "live") return { ...s, live: true };
      // A session that never opened has nothing on its screen worth keeping.
      return { at: "ended", ticket: s.live ? s.ticket : null, end: describeClose(e.code) };
    });
  }, []);

  const copy = async () => {
    try {
      const had = await view.current?.copy();
      if (!had) return toast.info("Select some text first");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy", { description: "This browser did not allow it. Ctrl+Shift+C works inside the terminal." });
    }
    view.current?.focus();
  };
  const paste = async () => {
    try {
      await view.current?.paste();
    } catch {
      toast.error("Could not paste", { description: "This browser did not allow it. Ctrl+Shift+V works inside the terminal." });
    }
    view.current?.focus();
  };

  const down = notRunning(app.status);
  const live = state.at === "session" && state.live;
  // The screen stays after a close, so what was on it can still be read and copied.
  const screen = state.at === "session" || (state.at === "ended" && state.ticket !== null);
  const sub = state.at === "session" && !state.live ? "Connecting" : live ? "Connected, as the container's own user" : "A shell inside this app's container";

  return (
    <TabCard
      id="at-term-title"
      icon="terminal"
      title="Terminal"
      sub={sub}
      className="at-term-card"
      actions={
        live ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void paste()}>
              Paste
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setState({ at: "idle" })}>
              Disconnect
            </button>
          </>
        ) : state.at === "ended" && state.end.retry ? (
          <PendingButton className="btn btn-sm btn-primary" pending={false} icon="refresh" onClick={() => void open()}>
            Open again
          </PendingButton>
        ) : null
      }
    >
      {state.at === "ended" ? (
        <div className="at-term-note">
          <Callout tone="warn" icon="alert">
            {`${state.end.title}. ${state.end.body}`}
          </Callout>
        </div>
      ) : null}

      {screen ? (
        <div className="at-term" data-ended={state.at === "ended" || undefined}>
          {/* One screen per ticket: a new session starts clean, and the old socket goes with the old one. */}
          <TerminalView key={state.ticket ?? "none"} ref={view} appId={app.id} ticket={state.ticket ?? ""} onEvent={onEvent} />
        </div>
      ) : state.at === "ended" ? null : down ? (
        <Empty icon="terminal" title="This app is not running" body="A terminal opens inside a running container. Start or deploy the app first." />
      ) : (
        <div className="at-query">
          <Callout icon="shieldCheck">
            {`The shell runs inside this app's container, as its own user, with nothing added. It stops after ${TERMINAL_IDLE_MINUTES} minutes without input, or ${TERMINAL_TOTAL_MINUTES} minutes at most, and whatever you started in it gets a hangup; something started with nohup keeps running until the container is replaced. Who opened it and when goes in the activity log; what you type does not. Opening one asks you to confirm it is you once every ${STEP_UP_MINUTES} minutes.`}
          </Callout>
          <div className="at-term-open">
            <PendingButton className="btn btn-primary" pending={state.at === "asking"} icon="terminal" onClick={() => void open()}>
              Open terminal
            </PendingButton>
          </div>
        </div>
      )}
    </TabCard>
  );
}
