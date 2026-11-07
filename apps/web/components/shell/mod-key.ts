"use client";

import { useSyncExternalStore } from "react";

/*
 * The shell's two chords, K (command menu) and B (sidebar), take Cmd on Apple platforms, where
 * Ctrl B and Ctrl K move the caret and cut a line in every text field, and Ctrl everywhere else.
 */

export const isApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);

const never = () => () => {};

/** The modifier's chip label: "Ctrl", or "⌘" on Apple platforms (after hydration; the server
    and the first paint say "Ctrl"). */
export const useModKey = () => useSyncExternalStore(never, () => (isApple() ? "⌘" : "Ctrl"), () => "Ctrl");

/** The aria-keyshortcuts value for the chord with `key`, as the label shows it. */
export const chord = (mod: string, key: string) => `${mod === "⌘" ? "Meta" : "Control"}+${key}`;
