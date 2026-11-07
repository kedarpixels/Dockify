import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projects as P } from "@dockify/contracts";
import { checkSpec, SERVICE_DEFAULT_VERSION, SERVICE_IMAGES } from "./app-source.ts";

/**
 * The dashboard's list (apps/web/components/new-app/service-versions.ts), read as text: the web is
 * not a module the api can load, and the file is one small object of string arrays, newest first.
 */
function dashboardVersions(): Record<string, string[]> {
  const text = readFileSync(new URL("../../../../web/components/new-app/service-versions.ts", import.meta.url), "utf8");
  const body = /SERVICE_VERSIONS[^=]*=\s*\{([\s\S]*?)\};/.exec(text)?.[1];
  if (!body) throw new Error("SERVICE_VERSIONS was not found in the web's service-versions.ts");
  return Object.fromEntries([...body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [m[1]!, [...m[2]!.matchAll(/"([^"]+)"/g)].map((v) => v[1]!)]));
}

const sorted = (v: readonly string[]) => [...v].sort();

describe("managed service versions", () => {
  const web = dashboardVersions();

  it("New app offers exactly the versions the API accepts", () => {
    expect(Object.keys(web).sort()).toEqual(["postgres", "redis"]);
    for (const service of ["postgres", "redis"] as const) {
      expect(sorted(web[service]!), service).toEqual(sorted(Object.keys(SERVICE_IMAGES[service])));
    }
    // Storage is offered by neither.
    expect(SERVICE_IMAGES.minio).toEqual({});
  });

  it("the dashboard's default is the API's default, the newest version", () => {
    expect(web.postgres![0]).toBe(SERVICE_DEFAULT_VERSION.postgres);
    expect(web.redis![0]).toBe(SERVICE_DEFAULT_VERSION.redis);
  });

  it("every version the dashboard offers passes the API's checks", () => {
    for (const service of ["postgres", "redis"] as const) {
      for (const version of web[service]!) {
        const spec = P.AppSpec.parse({ name: "svc", kind: service, target: "server", source: { type: "service", service, version } });
        expect(checkSpec(spec), `${service} ${version}`).toEqual([]);
      }
    }
  });
});
