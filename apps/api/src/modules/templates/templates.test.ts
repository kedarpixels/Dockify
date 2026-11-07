import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projects as P, templates as T, endpoints } from "@dockify/contracts";
import { POLICIES } from "../../policy.ts";
import { checkSpec } from "../projects/app-source.ts";
import { CATALOG } from "./catalog/index.ts";
import { checkTemplate, describeTemplate, generateSecret, resolveTemplate, TemplateError, type Template } from "./format.ts";

const UUID = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

const BASE: Template = {
  id: "demo", name: "Demo", summary: "s", category: "Developer tools", icon: "x", license: "MIT", homepage: "https://example.com", docs: "https://example.com/docs", firstRun: "f",
  primary: "web", memoryMb: { web: 256 }, secrets: { KEY: "hex32" }, inputs: [{ key: "ADMIN_EMAIL", label: "Admin email", hint: "h", type: "email" }],
  compose: `services:
  web:
    image: ghcr.io/acme/web:1.4
    ports: ["3000"]
    volumes: ["data:/data"]
    environment:
      SECRET_KEY: "{{secret.KEY}}"
      DATABASE_URL: "{{ref.db.url}}"
      PUBLIC_URL: "{{url}}"
      HOST_NAME: "{{hostname}}"
      ADMIN: "{{input.ADMIN_EMAIL}}"
      CACHE_ADDR: "redis://{{host.side}}:6379"
      MODE: production
  side:
    image: ghcr.io/acme/side:2.0
  db:
    image: postgres:17
volumes:
  data:
`,
};
const ids = { web: UUID(1), side: UUID(2), db: UUID(3) };
const input = { base: "demo", hostname: "demo.example.com", inputs: { ADMIN_EMAIL: "me@example.com" }, ids, hostOf: (id: string) => `dk-${id}`, secret: () => "GENERATED" };
const withCompose = (compose: string, over: Partial<Template> = {}): Template => ({ ...BASE, secrets: {}, inputs: [], memoryMb: {}, primary: "web", compose, ...over });
const WEB = "services:\n  web:\n    image: ghcr.io/acme/web:1.4\n    ports: ['3000']\n";

describe("a template cannot get past the compose checks", () => {
  // Everything a template could try, written in its own file: each must be a review failure.
  const HOSTILE: Array<[string, string]> = [
    ["privileged", `${WEB}    privileged: true\n`],
    ["capabilities", `${WEB}    cap_add: [SYS_ADMIN]\n`],
    ["the host network", `${WEB}    network_mode: host\n`],
    ["the host pid namespace", `${WEB}    pid: host\n`],
    ["a device", `${WEB}    devices: ['/dev/sda:/dev/sda']\n`],
    ["the docker socket", `${WEB}    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n`],
    ["a bind mount of the root", `${WEB}    volumes: ['/:/host']\n`],
    ["a relative bind mount", `${WEB}    volumes: ['./x:/x']\n`],
    ["a long form bind mount", `${WEB}    volumes: [{ type: bind, source: /etc, target: /x }]\n`],
    ["security options", `${WEB}    security_opt: ['seccomp:unconfined']\n`],
    ["a build", `${WEB}    build: .\n`],
    ["an entrypoint", `${WEB}    entrypoint: /bin/sh\n`],
    ["a host variable", `${WEB}    environment: { A: "\${HOME}" }\n`],
    ["a variable read from the host", `${WEB}    environment: [A]\n`],
    ["an env file", `${WEB}    env_file: .env\n`],
    ["a loader hook", `${WEB}    environment: { LD_PRELOAD: /x.so }\n`],
    ["NODE_OPTIONS", `${WEB}    environment: { NODE_OPTIONS: "--require=/x" }\n`],
    ["a Dockify variable", `${WEB}    environment: { DOCKIFY_ANYTHING: x }\n`],
    ["a volume over /etc", `${WEB}    volumes: ['data:/etc/x']\nvolumes:\n  data:\n`],
    ["an external volume", `${WEB}    volumes: ['data:/data']\nvolumes:\n  data: { external: true }\n`],
    ["a registry on loopback", "services:\n  web:\n    image: 127.0.0.1/x/y:1\n    ports: ['3000']\n"],
    ["a registry on a control network", "services:\n  web:\n    image: 172.30.3.2:5432/x/y:1\n    ports: ['3000']\n"],
    ["a registry on the metadata address", "services:\n  web:\n    image: 169.254.169.254/x/y:1\n    ports: ['3000']\n"],
    ["a user", `${WEB}    user: root\n`],
    ["an unknown key", `${WEB}    runtime: runc\n`],
  ];
  for (const [what, compose] of HOSTILE) {
    it(`refuses ${what}`, () => {
      expect(checkTemplate(withCompose(compose)).problems, what).not.toEqual([]);
      expect(() => resolveTemplate(withCompose(compose), { ...input, inputs: {} }), what).toThrow(TemplateError);
    });
  }
});

describe("the review itself", () => {
  const bad = (t: Template) => checkTemplate(t).problems.join(" | ");
  it("wants a pinned tag, and no digest written by hand", () => {
    for (const image of ["ghcr.io/a/b:latest", "ghcr.io/a/b", "a/b:main", "a/b:nightly"]) {
      expect(bad(withCompose(`services:\n  web:\n    image: ${image}\n    ports: ['3000']\n`)), image).toMatch(/pin|moving/);
    }
    expect(bad(withCompose(`services:\n  web:\n    image: a/b:1@sha256:${"a".repeat(64)}\n    ports: ['3000']\n`))).toMatch(/digest/);
  });
  it("wants a primary that can be routed", () => {
    expect(bad({ ...withCompose(WEB), primary: "nope" })).toMatch(/primary/);
    expect(bad(withCompose("services:\n  web:\n    image: a/b:1\n"))).toMatch(/no port/);
    expect(bad(withCompose("services:\n  web:\n    image: postgres:17\n"))).toMatch(/primary/);
  });
  it("allows a token only in an environment value", () => {
    expect(bad(withCompose(`${WEB}    command: "run {{url}}"\n`))).toMatch(/only appear/);
  });
  it("wants a link to be the whole value, and to a managed service with that field", () => {
    const t = (v: string, extra = "") => withCompose(`services:\n  web:\n    image: a/b:1\n    ports: ['3000']\n    environment:\n      A: "${v}"\n  db:\n    image: postgres:17\n  side:\n    image: a/c:1\n${extra}`);
    expect(bad(t("x{{ref.db.password}}"))).toMatch(/whole value/);
    expect(bad(t("{{ref.side.url}}"))).toMatch(/managed/);
    expect(bad(t("{{ref.db.bucket}}"))).toMatch(/no bucket/);
    expect(bad(t("{{ref.nope.url}}"))).toMatch(/managed/);
  });
  it("catches every kind of unknown token, a stray brace and an unused secret", () => {
    const t = (v: string) => withCompose(`${WEB}    environment:\n      A: "${v}"\n`);
    for (const v of ["{{nope}}", "{{secret.NOPE}}", "{{input.NOPE}}", "{{host.nope}}", "{{ref.a}}"]) expect(bad(t(v)), v).not.toBe("");
    expect(bad(t("{{url"))).toMatch(/stray/);
    expect(bad({ ...withCompose(WEB), secrets: { X: "hex16" } })).toMatch(/never used/);
    expect(bad({ ...withCompose(WEB), inputs: [{ key: "A", label: "A", hint: "", type: "text" }] })).toMatch(/never used/);
  });
  it("a template that fails review refuses to resolve, and says why", () => {
    expect(() => resolveTemplate(withCompose(`${WEB}    privileged: true\n`), { ...input, inputs: {} })).toThrow(/failed its review/);
  });
});

describe("resolving", () => {
  it("fills in every token, and only in values", () => {
    const apps = resolveTemplate(BASE, input);
    const web = apps.find((a) => a.service === "web")!;
    const env = Object.fromEntries((web.spec.env ?? []).map((e) => [e.key, e.value]));
    expect(env).toEqual({ SECRET_KEY: "GENERATED", PUBLIC_URL: "https://demo.example.com", HOST_NAME: "demo.example.com", ADMIN: "me@example.com", CACHE_ADDR: `redis://dk-${ids.side}:6379`, MODE: "production" });
    expect(web.refs).toEqual([{ key: "DATABASE_URL", serviceId: ids.db, field: "url" }]);
    expect(web.spec.run?.port).toBe(3000);
    expect(web.memoryMb).toBe(256);
    expect(web.id).toBe(ids.web);
  });
  it("seals what is generated and shows what is not", () => {
    const web = resolveTemplate(BASE, input).find((a) => a.service === "web")!;
    expect([...web.plain].sort()).toEqual(["ADMIN", "CACHE_ADDR", "HOST_NAME", "MODE", "PUBLIC_URL"]);
    expect(web.plain.has("SECRET_KEY")).toBe(false);
  });
  it("names the routed app from the base and the others after it", () => {
    const apps = resolveTemplate(BASE, input);
    expect(apps.map((a) => a.name).sort()).toEqual(["demo", "demo-db", "demo-side"]);
  });
  it("leaves no token behind", () => {
    const text = JSON.stringify(resolveTemplate(BASE, input).map((a) => a.spec));
    expect(text).not.toContain("{{");
  });
  it("makes a new secret each time, of the recipe's length, from letters and digits a URL can carry", () => {
    const a = generateSecret("hex32");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret("hex32")).not.toBe(a);
    expect(generateSecret("hex16")).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSecret("b64url32")).toMatch(/^[\w-]{43}$/);
  });
  it("gives two installs different secrets", () => {
    const env = () => resolveTemplate(BASE, { ...input, secret: undefined }).find((a) => a.service === "web")!.spec.env!.find((e) => e.key === "SECRET_KEY")!.value;
    expect(env()).not.toBe(env());
  });
  it("needs its address when its values use one", () => {
    expect(() => resolveTemplate(BASE, { ...input, hostname: null })).toThrow(/needs its address/);
  });

  describe("a typed field is hostile", () => {
    const refused = (value: string, type: "email" | "text" = "email") => {
      const t: Template = { ...BASE, inputs: [{ key: "ADMIN_EMAIL", label: "Admin email", hint: "h", type }] };
      return () => resolveTemplate(t, { ...input, inputs: { ADMIN_EMAIL: value } });
    };
    it("is required", () => {
      expect(() => resolveTemplate(BASE, { ...input, inputs: {} })).toThrow(/required/);
      expect(refused("   ")).toThrow(/required/);
    });
    it("takes no field the template does not have", () => {
      expect(() => resolveTemplate(BASE, { ...input, inputs: { ADMIN_EMAIL: "a@b.co", LD_PRELOAD: "/x" } })).toThrow(/does not take/);
    });
    for (const v of ["$(reboot)", "a@b.co;reboot", "`id`@b.co", "a@b.co\nLD_PRELOAD=/x", "{{secret.KEY}}", "{{url}}@b.co", "a b@c.co", "'@b.co", "../../etc@b.co", "a@b"]) {
      it(`refuses the email ${JSON.stringify(v)}`, () => expect(refused(v)).toThrow(TemplateError));
    }
    for (const v of ["$(reboot)", "a`id`", "x;y", "a|b", "{{secret.KEY}}", "a\nb", 'q"uote', "a\u0000b", "${HOME}", "x".repeat(121)]) {
      it(`refuses the text ${JSON.stringify(v)}`, () => expect(refused(v, "text")).toThrow(TemplateError));
    }
    it("a typed token could never expand anyway: a value is substituted once", () => {
      const t: Template = { ...BASE, compose: BASE.compose };
      const apps = resolveTemplate(t, input);
      expect(JSON.stringify(apps[0]!.spec)).not.toContain("GENERATED{{");
    });
    it("a name that would make a bad app name is refused", () => {
      expect(() => resolveTemplate(BASE, { ...input, base: "Bad Name" })).toThrow(TemplateError);
      expect(() => resolveTemplate(BASE, { ...input, base: "dk-x" })).toThrow(TemplateError);
    });
  });
});

describe("what the dashboard is shown", () => {
  const row = describeTemplate(BASE);
  it("is the contract's shape", () => {
    expect(T.TemplateRow.safeParse(row).success).toBe(true);
  });
  it("never holds a value, only what kind of value it will be", () => {
    const web = row.apps.find((a) => a.service === "web")!;
    expect(web.env.find((e) => e.key === "SECRET_KEY")).toEqual({ key: "SECRET_KEY", shows: "generated secret", secret: true });
    expect(web.env.find((e) => e.key === "DATABASE_URL")).toEqual({ key: "DATABASE_URL", shows: "link to db: url", secret: true });
    expect(web.env.find((e) => e.key === "PUBLIC_URL")).toEqual({ key: "PUBLIC_URL", shows: "https://your-domain", secret: false });
    expect(JSON.stringify(row)).not.toContain("{{");
  });
  it("names the image, the port, the volume and the memory", () => {
    expect(row.apps.find((a) => a.service === "web")).toMatchObject({ image: "ghcr.io/acme/web:1.4", port: 3000, primary: true, memoryMb: 256, volumes: [{ name: "data", path: "/data" }] });
    expect(row.apps.find((a) => a.service === "db")).toMatchObject({ managed: "Postgres 17", image: "", primary: false });
    expect(row.needsDomain).toBe(true);
  });
});

describe("the routes", () => {
  it("deploying is an elevated admin's, listing a viewer's", () => {
    expect(POLICIES["projects.apps.template"]).toEqual({ access: "elevated", role: "admin" });
    expect(POLICIES["templates.list"]).toMatchObject({ access: "session", role: "viewer" });
  });
  it("the body takes a template id, never a file or an image", () => {
    const ok = { templateId: "umami", environment: "production", name: "umami", domain: { type: "test" } };
    expect(T.DeployTemplateBody.safeParse(ok).success).toBe(true);
    for (const extra of [{ compose: "services: {}" }, { url: "https://evil.test/t.yml" }, { image: "x:1" }, { env: [] }]) {
      expect(T.DeployTemplateBody.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(T.DeployTemplateBody.safeParse({ ...ok, templateId: "../../etc/passwd" }).success).toBe(false);
    expect(T.DeployTemplateBody.safeParse({ ...ok, domain: { type: "custom", hostname: "not a host" } }).success).toBe(false);
    expect(endpoints["projects.apps.template"].method).toBe("POST");
  });
});

describe("the catalog", () => {
  it("has at least 6 templates, each with its own id", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(6);
    expect(new Set(CATALOG.map((t) => t.id)).size).toBe(CATALOG.length);
  });
  for (const t of CATALOG) {
    describe(t.id, () => {
      it("passes its review", () => {
        expect(checkTemplate(t).problems).toEqual([]);
      });
      it("states its license, its docs and what the first visit is", () => {
        expect(t.license.length).toBeGreaterThan(1);
        expect(t.docs).toMatch(/^https:\/\//);
        expect(t.homepage).toMatch(/^https:\/\//);
        expect(t.firstRun.length).toBeGreaterThan(10);
        expect(t.summary.length).toBeLessThanOrEqual(70);
      });
      it("resolves, passes every spec check, and leaves no known default secret", () => {
        const ids = Object.fromEntries(checkTemplate(t).specs.map((s, i) => [s.name, UUID((i % 9) + 1)]));
        const inputs = Object.fromEntries(t.inputs.map((i) => [i.key, i.type === "email" ? "me@example.com" : "Example"]));
        const apps = resolveTemplate(t, { base: "x", hostname: "x.example.com", inputs, ids, hostOf: (id) => `dk-${id}` });
        for (const a of apps) {
          expect(P.AppSpec.safeParse(a.spec).success).toBe(true);
          expect(checkSpec(a.spec)).toEqual([]);
          for (const e of a.spec.env ?? []) expect(e.value, `${a.name}.${e.key}`).not.toMatch(/\{\{|changeme|change_me|password123|^secret$/i);
        }
        // A key that holds a credential is generated or linked, never written in the file.
        for (const s of checkTemplate(t).specs) {
          for (const e of s.env ?? []) {
            if (/PASS(WORD|WD)?$|SECRET|TOKEN|ENCRYPTION_KEY|ACCESS_KEY/i.test(e.key) && !/_FILE$/.test(e.key)) expect(e.value, `${s.name}.${e.key}`).toMatch(/\{\{(secret|ref)\./);
          }
        }
      });
      it("gives every container a sensible memory cap", () => {
        for (const v of Object.values(t.memoryMb)) expect(v).toBeGreaterThanOrEqual(64);
      });
    });
  }
  it("lists a file for every template and a template for every file", () => {
    const dir = path.resolve(import.meta.dirname, "catalog");
    const files = readdirSync(dir).filter((f) => f !== "index.ts").map((f) => f.replace(/\.ts$/, "")).sort();
    expect(files).toEqual(CATALOG.map((t) => t.id).sort());
    expect(readFileSync(path.join(dir, "index.ts"), "utf8")).not.toMatch(/fetch|https?:\/\//);
  });
  it("has no network access at run time: the module reads only its own folder", () => {
    for (const f of ["format.ts", "index.ts"]) expect(readFileSync(path.resolve(import.meta.dirname, f), "utf8"), f).not.toMatch(/\bfetch\(|node:https?|undici/);
  });
});
