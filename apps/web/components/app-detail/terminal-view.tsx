"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { toast } from "@/components/ui/toast";
import { chunkBytes, clampSize, MAX_PASTE_BYTES, terminalUrl } from "@/lib/terminal";

/*
 * The screen and the socket, in a module of its own so xterm.js loads only when a terminal opens
 * (terminal-tab.tsx imports this through next/dynamic). xterm is the one real choice: a shell needs
 * a whole terminal emulator, and vim or top do not work on anything less.
 *
 * What runs in a container may be hostile, and its output lands here. So: xterm renders text, never
 * markup; hyperlinks in the output do nothing when clicked; there is no clipboard addon, so output
 * cannot read or write the clipboard; nothing is ever written to storage.
 *
 * data-raw-keys tells the shell's global shortcuts to leave every chord to the terminal.
 */

export interface TerminalHandle {
  copy(): Promise<boolean>;
  paste(): Promise<void>;
  focus(): void;
}

export type ViewEvent = { type: "live" } | { type: "closed"; code: number };

const FONT = 'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** The colours from the page's tokens, read off a real element so the light and dark values both follow. */
function themeFrom(el: Element) {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  const background = v("--term-bg");
  const foreground = v("--term-fg");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: v("--term-sel"),
    black: v("--term-black"), red: v("--term-red"), green: v("--term-green"), yellow: v("--term-yellow"),
    blue: v("--term-blue"), magenta: v("--term-magenta"), cyan: v("--term-cyan"), white: v("--term-white"),
    brightBlack: v("--term-bright-black"), brightRed: v("--term-red"), brightGreen: v("--term-green"), brightYellow: v("--term-yellow"),
    brightBlue: v("--term-blue"), brightMagenta: v("--term-magenta"), brightCyan: v("--term-cyan"), brightWhite: v("--term-bright-white"),
  };
}

export const TerminalView = forwardRef<TerminalHandle, { appId: string; ticket: string; onEvent: (e: ViewEvent) => void }>(function TerminalView({ appId, ticket, onEvent }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const sendPaste = useRef<(text: string) => void>(() => {});
  const event = useRef(onEvent);
  useEffect(() => {
    event.current = onEvent;
  }, [onEvent]);

  useImperativeHandle(ref, () => ({
    async copy() {
      const text = term.current?.getSelection() ?? "";
      if (!text) return false;
      await navigator.clipboard.writeText(text);
      return true;
    },
    async paste() {
      sendPaste.current(await navigator.clipboard.readText());
    },
    focus() {
      term.current?.focus();
    },
  }), []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFrom(el),
      allowProposedApi: false,
      // A link in a container's output is plain text here: clicking it must not open anything.
      linkHandler: { activate: () => {} },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    term.current = t;
    fit.fit();

    const ws = new WebSocket(terminalUrl(window.location, appId));
    ws.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    const sendBytes = (bytes: Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      for (const piece of chunkBytes(bytes)) ws.send(piece);
    };
    // Goes through xterm so bracketed paste works, and is refused up front past what the session takes.
    sendPaste.current = (text) => {
      if (encoder.encode(text).length > MAX_PASTE_BYTES) {
        toast.error("That paste is too large", { description: "The terminal takes 256 KB at a time." });
        return;
      }
      t.paste(text);
    };
    // Ctrl+Shift+V is the browser's own paste, which xterm takes from the event. Seen first, here.
    const guardPaste = (e: ClipboardEvent) => {
      if (encoder.encode(e.clipboardData?.getData("text") ?? "").length <= MAX_PASTE_BYTES) return;
      e.preventDefault();
      e.stopPropagation();
      toast.error("That paste is too large", { description: "The terminal takes 256 KB at a time." });
    };
    el.addEventListener("paste", guardPaste, { capture: true });
    t.attachCustomKeyEventHandler((e) => {
      // The two chords a terminal leaves free. Ctrl+C itself stays the shell's interrupt.
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        const text = t.getSelection();
        if (text) void navigator.clipboard.writeText(text).catch(() => {});
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyV") return false;
      return true;
    });

    let ready = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "auth", ticket, ...clampSize(t.cols, t.rows) }));
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return t.write(new Uint8Array(m.data as ArrayBuffer));
      if (m.data === '{"t":"ready"}' && !ready) {
        ready = true;
        event.current({ type: "live" });
        t.focus();
      }
    };
    ws.onclose = (e) => event.current({ type: "closed", code: e.code });
    const data = t.onData((d) => sendBytes(encoder.encode(d)));
    const binary = t.onBinary((d) => sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0))));
    const resized = t.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN && ready) ws.send(JSON.stringify({ t: "resize", ...clampSize(cols, rows) }));
    });

    // Only whole cells: a resize that does not change the grid sends nothing.
    let frame = 0;
    const seen = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // A host with no size yet, in a tab being closed.
        }
      });
    });
    seen.observe(el);

    const retheme = new MutationObserver(() => {
      t.options.theme = themeFrom(el);
    });
    retheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });

    return () => {
      el.removeEventListener("paste", guardPaste, { capture: true });
      cancelAnimationFrame(frame);
      seen.disconnect();
      retheme.disconnect();
      data.dispose();
      binary.dispose();
      resized.dispose();
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
      t.dispose();
      term.current = null;
    };
  }, [appId, ticket]);

  return <div ref={host} className="at-term-screen" data-raw-keys aria-label="Terminal" />;
});
