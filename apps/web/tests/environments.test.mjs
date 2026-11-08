// A project is a folder of apps: with one environment it shows none anywhere. Lists of several
// projects name an app's environment only when that project's apps sit in more than one, so a project
// whose only environment is called "dev" or "staging" reads as plainly as one called production.
// Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectsShowingEnvironments, showsEnvironments } from "../lib/environments.ts";

test("one environment shows none, two or more show them all", () => {
  assert.equal(showsEnvironments([]), false);
  assert.equal(showsEnvironments([{ name: "production" }]), false);
  assert.equal(showsEnvironments([{ name: "staging" }]), false);
  assert.equal(showsEnvironments([{ name: "production" }, { name: "dev" }]), true);
});

test("a list of several projects names environments per project, by where its apps sit", () => {
  const shows = projectsShowingEnvironments([
    { projectSlug: "solo", environment: "dev" },
    { projectSlug: "solo", environment: "dev" },
    { projectSlug: "both", environment: "production" },
    { projectSlug: "both", environment: "development" },
    { projectSlug: "prodonly", environment: "production" },
  ]);
  assert.equal(shows("solo"), false);
  assert.equal(shows("both"), true);
  assert.equal(shows("prodonly"), false);
  // A project with no apps listed has nothing to name.
  assert.equal(shows("empty"), false);
});
