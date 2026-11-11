/* Server-safe theme bits. The client toggle lives in components/ui/theme-switch.tsx. */

export const THEME_KEY = "theme";
export const SIDEBAR_KEY = "sidebar";

/* Runs before first paint: a saved theme wins, otherwise the system theme. Also restores the
   sidebar width, so a collapsed sidebar never opens wide for a frame. */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d);document.documentElement.dataset.sidebar=localStorage.getItem("${SIDEBAR_KEY}")==="collapsed"?"collapsed":"open"}catch(e){}`;
