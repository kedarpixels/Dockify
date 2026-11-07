// Regression: the app page loader must never ship a secret value in the page data.
// Run: npm test (node --test, Node 22.18+ strips the types of the imported module).
import assert from "node:assert/strict";
import { test } from "node:test";
import { appEnvPath, envFromState } from "../lib/pages/app-env.ts";

test("the app page reads the secret-free env/state route, not the raw env route", () => {
  assert.equal(appEnvPath("my app"), "/api/v1/projects/my%20app/env/state");
  assert.ok(!appEnvPath("x").endsWith("/env"));
});

test("a secret value never survives into the page data, even if the API sent one", () => {
  const out = envFromState({
    environments: [
      {
        name: "production",
        vars: [
          { key: "DATABASE_URL", value: "postgres://u:p@db/x", secret: true, updatedAt: "2026-10-30T00:00:00.000Z" },
          { key: "API_KEY", value: null, secret: true, updatedAt: "2026-10-30T00:00:00.000Z" },
          { key: "LOG_LEVEL", value: "info", secret: false, updatedAt: "2026-10-30T00:00:00.000Z" },
        ],
      },
    ],
  });
  assert.deepEqual(
    out.environments[0].vars.map((v) => [v.key, v.value, v.secret]),
    [
      ["DATABASE_URL", "", true],
      ["API_KEY", "", true],
      ["LOG_LEVEL", "info", false],
    ],
  );
  assert.ok(!JSON.stringify(out).includes("postgres://"));
});

test("a linked variable keeps its link and never a value", () => {
  const ref = { resourceId: "pg-1", resourceName: "postgres", kind: "postgres", environment: "production", field: "url" };
  const out = envFromState({
    environments: [{ name: "production", vars: [{ key: "DATABASE_URL", value: "postgres://leak", secret: false, updatedAt: "2026-10-30T00:00:00.000Z", ref }] }],
  });
  assert.deepEqual(out.environments[0].vars[0], { key: "DATABASE_URL", value: "", secret: true, updatedAt: "2026-10-30T00:00:00.000Z", ref });
});
