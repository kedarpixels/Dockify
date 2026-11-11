// The project Variables tables wrapped long keys onto two lines and dropped the lock icon to a third,
// and the overrides table's app column cut names like game-dashboard short. A key never wraps, its
// column fits its longest key, and each app is named once above its rows. Run: npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../app/styles/env-table.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const workbench = readFileSync(new URL("../components/project-extras/env-workbench.tsx", import.meta.url), "utf8");
const table = readFileSync(new URL("../components/env/env-table.tsx", import.meta.url), "utf8");

/** The body of the first rule whose selector is exactly `selector`, searched in `from`. */
function rule(selector, from = css) {
  const at = from.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `no rule for ${selector}`);
  return from.slice(at, from.indexOf("}", at));
}

const wide = css.slice(css.indexOf("@container ev-vars (width >= 760px)"), css.indexOf("@container ev-vars (width < 760px)"));
const px = (s) => [...s.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));

test("a key stays on one line, its lock right after it, and cuts with an ellipsis", () => {
  assert.match(rule(".ev-vars-fit .ev-var-key"), /flex-wrap: nowrap/);
  const text = rule(".ev-vars-fit .ev-var-keytext");
  assert.match(text, /white-space: nowrap/);
  assert.match(text, /text-overflow: ellipsis/);
  assert.match(text, /overflow: hidden/);
  // The lock never shrinks, so it is the key text that gives way.
  assert.match(rule(".ev-var-lock"), /flex: none/);
});

test("in columns the rows share one key track sized to the longest key, and the value takes the rest", () => {
  assert.ok(wide.length > 0, "the column layout lives in the wide container query");
  const cols = rule(".ev-vars-fit", wide);
  assert.match(cols, /minmax\(1\d\dpx, max-content\)/, "the key track follows its content");
  assert.match(cols, /1fr\)/, "the value track takes what is left");
  assert.match(rule(".ev-vars-fit > .ev-vars", wide), /grid-template-columns: subgrid/);
  assert.match(rule(".ev-vars-fit .ev-var", wide), /grid-template-columns: subgrid/);
  // The cap: past it a key cuts instead of starving the value.
  assert.match(rule(".ev-vars-fit .ev-var-key", wide), /max-width: min\(320px/);
  // Key floor, value floor, used at, updated, keys, and four 12px gaps fit in 760px.
  const tracks = px(cols.split("grid-template-columns:")[1]);
  assert.ok(tracks.reduce((a, b) => a + b, 0) + 4 * 12 <= 760);
});

test("the overrides table names each app once above its rows, never in a column", () => {
  assert.doesNotMatch(css, /ev-var-app|\.ev-var-a\b|data-app/);
  assert.doesNotMatch(table, /AppCell|RowApp/);
  // The head spans every track, and a long name wraps instead of cutting.
  assert.match(rule(".ev-group"), /grid-column: 1 \/ -1/);
  assert.match(rule(".ev-group-name"), /overflow-wrap: anywhere/);
  assert.match(rule(".ev-group-count"), /flex: none/);
  // Every app after the first opens with a whole-pixel rule.
  assert.match(rule(".ev-vars > .ev-group ~ .ev-group"), /border-top: 1px solid var\(--line\)/);
  assert.match(workbench, /group=\{self \? undefined : \{ name: appTitle\(g\.app\)/);
  assert.match(workbench, /<EnvGroupHead name=\{group\.name\}/);
});

test("below 760px the rows stack as before, so nothing forces a sideways scroll", () => {
  const narrow = css.slice(css.indexOf("@container ev-vars (width < 760px)"));
  assert.match(rule(".ev-var", narrow), /grid-template-columns: minmax\(0, 1fr\) auto/);
  // Nothing outside the wide query sizes a track by content or makes a row a subgrid.
  const outside = css.replace(wide, "");
  assert.doesNotMatch(outside, /subgrid;/);
  assert.doesNotMatch(outside, /max-content\)/);
});

test("both workbench tables use the fitted layout, and a cut key shows whole on hover", () => {
  assert.equal([...workbench.matchAll(/<FitTable>\s*<EnvTableHead targets \/>/g)].length, 2);
  assert.match(workbench, /className="ev-vars-fit"/);
  assert.match(workbench, /scrollWidth > key\.clientWidth\) key\.title = key\.textContent/);
});
