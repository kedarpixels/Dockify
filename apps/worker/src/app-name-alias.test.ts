/**
 * Every running app answers to its own name on its environment network (deploy/containers.ts
 * appAliases), whatever that name is, "api" and "web" included. That is safe only while nothing of
 * the control plane that joins a tenant network looks up a bare service name there: Traefik (proxy,
 * proxy-direct) is the one that stays joined, and the agent joins only to dial a container by its
 * dk- alias or address. These pin that.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_SERVICE_NAMES } from "@dockify/contracts";
import { API_UPSTREAM, WEB_UPSTREAM } from "./edge/ingress.ts";

const compose = readFileSync(path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml"), "utf8");
const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(compose)?.[1] ?? "";
/** A URL or host:port whose host is one label, the kind Docker's DNS answers from a joined network. */
const BARE_HOST = /(?:\/\/|\s)([a-z][a-z0-9-]*):\d{2,5}\b/g;

describe("an app's name can never stand in for the control plane", () => {
  it("the dashboard upstreams Traefik dials are addresses, not names", () => {
    for (const u of [API_UPSTREAM, WEB_UPSTREAM]) expect(new URL(u).hostname).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it.each(["proxy", "proxy-direct", "agent"])("%s names no other service by a bare hostname", (name) => {
    const body = service(name);
    expect(body.length).toBeGreaterThan(0);
    const bare = [...body.matchAll(BARE_HOST)].map((m) => m[1]!).filter((h) => RESERVED_SERVICE_NAMES.includes(h));
    expect(bare).toEqual([]);
  });
});
