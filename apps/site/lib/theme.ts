/* Same key as the dashboard. */
export const THEME_KEY = "theme";

/* Runs before first paint: a saved theme wins, otherwise the system theme. */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}`;
