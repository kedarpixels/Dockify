/*
 * The plain rules behind an app on Vercel's tabs (vercel-tabs.tsx), apart from the markup so the
 * tests can hold them: which Variables tab it gets, what stands in for a value never shown, and
 * Vercel's framework names as people say them.
 */

/** A followed app's variables live on Vercel; a deploy target's are Dockify's, sent there on deploy. */
export function variablesOnVercel(target: { kind: "server" | "vercel"; mode?: "follow" | "deploy" } | null | undefined): boolean {
  return target?.kind === "vercel" && target.mode !== "deploy";
}

const FRAMEWORK: Record<string, string> = {
  nextjs: "Next.js",
  vite: "Vite",
  remix: "Remix",
  astro: "Astro",
  nuxtjs: "Nuxt",
  sveltekit: "SvelteKit",
  "sveltekit-1": "SvelteKit",
  gatsby: "Gatsby",
  "create-react-app": "Create React App",
  angular: "Angular",
  vue: "Vue",
  hugo: "Hugo",
  docusaurus: "Docusaurus",
  "docusaurus-2": "Docusaurus",
  hono: "Hono",
  express: "Express",
};

/** Vercel's framework slug as people say it; an unknown slug reads as Vercel wrote it, none as Other. */
export const frameworkLabel = (f: string | null) => (f ? (FRAMEWORK[f] ?? f) : "Other");

/** What stands in for a value Dockify does not show, and why. `values` is whether this reader gets plain ones. */
export function valueNote(e: { type: string }, values: boolean): string {
  if (e.type === "sensitive") return "Sensitive, Vercel never shows it";
  if (e.type === "system") return "Set by Vercel";
  if (e.type === "encrypted" || e.type === "secret") return "Encrypted on Vercel";
  return values ? "Empty" : "Hidden, admins only";
}

/** The domains a production deployment is visited at: its custom ones, else Vercel's first name for it. */
export function visitHosts(aliases: string[], max = 3): { shown: string[]; more: number; custom: boolean } {
  const custom = aliases.filter((a) => !a.endsWith(".vercel.app"));
  if (custom.length) return { shown: custom.slice(0, max), more: Math.max(0, custom.length - max), custom: true };
  return { shown: aliases.slice(0, 1), more: 0, custom: false };
}
