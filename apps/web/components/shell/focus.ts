/*
 * The page's main region as a focus target: the skip link jumps to it, and focus that navigation
 * or a closing menu would drop on the document lands there instead, so the next Tab starts in the
 * content. A page that names its main `#main` is used as is; otherwise the shell's main element
 * is found and made focusable by script only (tabindex -1, so Tab never stops on it).
 */

function mainRegion(): HTMLElement | null {
  return document.getElementById("main") ?? document.querySelector<HTMLElement>(".shell-main > main");
}

/** Focuses the main region. `scroll` brings its top into view (the skip link); otherwise the
    scroll position is left to the router. Returns false when the page has no main region. */
export function focusMain({ scroll = false }: { scroll?: boolean } = {}): boolean {
  const main = mainRegion();
  if (!main) return false;
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
  main.focus({ preventScroll: true });
  if (scroll) main.scrollIntoView({ block: "start" });
  return document.activeElement === main;
}
