"use client";

import { useSyncExternalStore } from "react";

/* Cmd on Apple platforms, where Ctrl B and Ctrl K move the caret and cut a line in every text field. */

export const isApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);

const never = () => () => {};

/** "⌘" only after hydration; the server and the first paint say "Ctrl". */
export const useModKey = () => useSyncExternalStore(never, () => (isApple() ? "⌘" : "Ctrl"), () => "Ctrl");

/** The aria-keyshortcuts value for the chord with `key`, as the label shows it. */
export const chord = (mod: string, key: string) => `${mod === "⌘" ? "Meta" : "Control"}+${key}`;
