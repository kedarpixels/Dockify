// Focus that navigation or a closing menu would drop on the document lands on the main region
// instead. Without a `#main`, the shell's main element is made focusable by script (tabindex -1).

function mainRegion(): HTMLElement | null {
  return document.getElementById("main") ?? document.querySelector<HTMLElement>(".shell-main > main");
}

/** `scroll` brings its top into view (the skip link). Returns false when the page has no main region. */
export function focusMain({ scroll = false }: { scroll?: boolean } = {}): boolean {
  const main = mainRegion();
  if (!main) return false;
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
  main.focus({ preventScroll: true });
  if (scroll) main.scrollIntoView({ block: "start" });
  return document.activeElement === main;
}
