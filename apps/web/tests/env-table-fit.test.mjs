// The project Variables tables wrapped long keys onto two lines and dropped the lock icon to a third,
// while the value column sat mostly empty. The key column now takes the width its longest key
// needs, up to a cap, and a key never wraps. Run: npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../app/styles/env-table.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const workbench = readFileSync(new URL("../components/project-extras/env-workbench.tsx", import.meta.url), "utf8");

/** The body of the first rule whose selector is exactly `selector`, searched in `from`. */
function rule(selector, from = css) {
  const at = from.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `no rule for ${selector}`);
  return from.slice(at, from.indexOf("}", at));
}

const wide = css.slice(css.indexOf("@container ev-vars (width >= 760px)"), css.indexOf("/* Narrow:"));
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
  for (const sel of [".ev-vars-fit", ".ev-vars-fit[data-app]"]) {
    const cols = rule(sel, wide);
    assert.match(cols, /minmax\(1\d\dpx, max-content\)/, `${sel}: the key track follows its content`);
    assert.match(cols, /1fr\)/, `${sel}: the value track takes what is left`);
  }
  assert.match(rule(".ev-vars-fit > .ev-vars", wide), /grid-template-columns: subgrid/);
  assert.match(rule(".ev-vars-fit .ev-var", wide), /grid-template-columns: subgrid/);
  // The cap: past it a key cuts instead of starving the value.
  assert.match(rule(".ev-vars-fit .ev-var-key", wide), /max-width: min\(320px/);
});

test("the app column keeps its 120px and the narrowest column layout fits in 760px", () => {
  const app = rule(".ev-vars-fit[data-app]", wide).split("grid-template-columns:")[1];
  // The 128px track less the row's 8px padding is the 120px app cell.
  assert.ok(app.trim().startsWith("128px "));
  for (const n of [128, 168, 112, 96, 88, 100]) assert.ok(px(app).includes(n), `${n}px track`);
  // App, key floor, value floor (the clamp's minimum), used at, updated, keys, and five 12px gaps.
  assert.ok(128 + 168 + 112 + 96 + 88 + 100 + 5 * 12 <= 760);
  const shared = px(rule(".ev-vars-fit", wide).split("grid-template-columns:")[1]);
  assert.ok(shared.reduce((a, b) => a + b, 0) + 4 * 12 <= 760);
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
  assert.match(workbench, /<FitTable app=\{!self\}>\s*<EnvTableHead targets app=\{!self\} \/>/);
  assert.match(workbench, /<FitTable>\s*<EnvTableHead targets \/>/);
  assert.match(workbench, /className="ev-vars-fit"/);
  assert.match(workbench, /scrollWidth > key\.clientWidth\) key\.title = key\.textContent/);
});
