"use client";

import { useSyncExternalStore } from "react";

/*
 * Single-key shortcuts ("D" for the theme, "/" for search): one guard for where they may fire and
 * one switch to turn them all off (WCAG 2.1.4). The choice lives in this browser, like the theme,
 * and defaults to on.
 *
 *   if (!singleKeyShortcutsOn() || ownsKeys(e.target)) return;      inside a keydown handler
 *   const [on, setOn] = useSingleKeyShortcuts();                     a settings switch, or a hint
 */

const KEY = "single-key-shortcuts";
const listeners = new Set<() => void>();

/** Whether single-key shortcuts may fire. On unless the reader turned them off. */
export function singleKeyShortcutsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

function setSingleKeyShortcuts(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    /* storage blocked: nothing to remember, the default (on) stays */
  }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab changing it counts too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The preference and its setter; on during the server render and the first client render. */
export function useSingleKeyShortcuts(): [on: boolean, setOn: (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, singleKeyShortcutsOn, () => true);
  return [on, setSingleKeyShortcuts];
}

/* Widgets that read letters and arrows as their own input. */
const KEYED = [
  "input",
  "textarea",
  "select",
  "[contenteditable]",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menubar']",
  "[role='grid']",
  "[role='tree']",
  "[role='treegrid']",
  "[role='radiogroup']",
  "[role='spinbutton']",
  "[role='slider']",
  "[role='log']",
  "[data-raw-keys]",
].join(",");

/**
 * True when the key belongs to whatever has focus: a field, an editable region, or a widget that
 * reads keys itself (a listbox's type-ahead, a menu, a grid, a radio group, a terminal marked
 * `data-raw-keys`). A single-key shortcut stands down there.
 */
export function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(KEYED) !== null;
}
