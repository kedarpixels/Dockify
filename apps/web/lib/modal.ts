/*
 * The modal layer shared by Dialog, the session notice and the popovers inside a dialog: which layer
 * is on top, one scroll lock, and an inert background.
 *
 * A layer that names its element (Dialog's panel, the session notice) makes everything beside the
 * path from that element up to the body inert while it is the top one, so Tab, a screen reader's
 * reading cursor and the pointer reach only it. The path itself stays live, so a layer rendered
 * inside the app (the session notice) keeps working, and so do the toasts, the live regions, the
 * route announcer and the step-up root. Only what this module made inert is ever made live again.
 * A popover inside a dialog (a Select list, the date picker) joins the stack without an element and
 * leaves the dialog's background as it is.
 */

const layers: Array<{ id: string; el: HTMLElement | null }> = [];
let locks = 0;
let savedOverflow = "";

const KEEP = ".toaster, [data-step-up], next-route-announcer, .sr, script, style, link";
const MARK = "data-layer-inert";

function shield() {
  for (const el of document.querySelectorAll<HTMLElement>(`[${MARK}]`)) {
    el.removeAttribute(MARK);
    el.inert = false;
  }
  const top = [...layers].reverse().find((l) => l.el?.isConnected)?.el;
  if (!top) return;
  for (let node: HTMLElement = top; node.parentElement && node !== document.body; node = node.parentElement) {
    for (const sib of node.parentElement.children) {
      if (sib === node || !(sib instanceof HTMLElement) || sib.inert || sib.matches(KEEP)) continue;
      sib.inert = true;
      sib.setAttribute(MARK, "");
    }
  }
}

/** Puts `id` on top and locks page scroll; with `el`, the rest of the page goes inert. Returns the release, which undoes all of it. */
export function openLayer(id: string, el: HTMLElement | null = null): () => void {
  layers.push({ id, el });
  if (locks++ === 0) {
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }
  if (el) shield();
  return () => {
    const at = layers.findLastIndex((l) => l.id === id);
    const had = at >= 0 && layers[at]!.el !== null;
    if (at >= 0) layers.splice(at, 1);
    if (--locks === 0) document.documentElement.style.overflow = savedOverflow;
    if (had) shield();
  };
}

/** True while `id` is the newest open layer, so only it answers keys and focus. */
export const isTopLayer = (id: string) => layers.at(-1)?.id === id;
