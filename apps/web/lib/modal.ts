// A layer that names its element makes everything beside the path from it up to the body inert while
// it is on top. A popover inside a dialog joins without an element and leaves the background as it is.

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
