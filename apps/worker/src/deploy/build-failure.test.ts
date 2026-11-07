/**
 * A Dockerfile whose RUN step failed was reported as "unrecognized image format" and built
 * three times. buildctl writes nothing to stdout when its solve fails, so the docker load of that
 * empty stream rejected first and the non-zero buildctl exit was never looked at.
 * A bad image tag showed the daemon's raw JSON body and was retried three times.
 * The deploy log showed the build secret key list as "secret=[REDACTED]".
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARK, Redactor } from "@dockify/redact";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, spawn: vi.fn() };
});

const { spawn } = await import("node:child_process");
const { buildFailure, buildImage, OutputTail, planBuild, planLogLines, settleBuild } = await import("@dockify/engine");
const { pullFailure, pullImage } = await import("./pull.ts");
const { daemonMessage, DockerError } = await import("@dockify/engine");
const { isPermanent } = await import("@dockify/engine");
const { DeployLog } = await import("./log.ts");
type DockerApi = import("@dockify/engine").DockerApi;

/** The error a call that must fail failed with. */
const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected the call to fail"); }, (e: unknown) => e as Error);
const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const failLater = (ms: number, error: Error) => new Promise<never>((_, reject) => setTimeout(() => reject(error), ms));

describe("settleBuild: buildctl's exit decides, not the image load", () => {
  it("waits for buildctl when the load of its empty stdout fails first", async () => {
    const drain = vi.fn();
    const kill = vi.fn();
    const end = await settleBuild({
      exited: later(30, 1),
      loaded: failLater(5, new Error("unrecognized image format")),
      drain,
      kill,
    });
    expect(end.code).toBe(1);
    expect(end.killed).toBe(false);
    expect((end.loadError as Error).message).toBe("unrecognized image format");
    // The pipe is drained so a buildctl still writing never blocks on it.
    expect(drain).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });

  it("reads the exit first when it comes first", async () => {
    const end = await settleBuild({ exited: later(1, 1), loaded: failLater(20, new Error("EOF")), drain: () => {}, kill: () => {} });
    expect(end).toMatchObject({ code: 1, killed: false });
  });

  it("succeeds when both halves succeed, in either order", async () => {
    expect(await settleBuild({ exited: later(1, 0), loaded: later(10, undefined), drain: () => {}, kill: () => {} })).toEqual({ code: 0, killed: false, loadError: null });
    expect(await settleBuild({ exited: later(10, 0), loaded: later(1, undefined), drain: () => {}, kill: () => {} })).toEqual({ code: 0, killed: false, loadError: null });
  });

  it("kills a build still running past the grace period after the load failed, and keeps the load error", async () => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((r) => (exit = r));
    const kill = vi.fn(() => exit(-1));
    const end = await settleBuild({ exited, loaded: failLater(1, new Error("daemon refused the load")), drain: () => {}, kill, graceMs: 20 });
    expect(kill).toHaveBeenCalledOnce();
    expect(end.killed).toBe(true);
    expect((end.loadError as Error).message).toBe("daemon refused the load");
  });

  it("rejects when buildctl could not start, and leaves no unhandled rejection behind", async () => {
    const enoent = Object.assign(new Error("spawn buildctl ENOENT"), { code: "ENOENT" });
    await expect(settleBuild({ exited: failLater(1, enoent), loaded: failLater(5, new Error("EOF")), drain: () => {}, kill: () => {} })).rejects.toBe(enoent);
    // The load fails first and the exit rejects during the grace race: still the spawn error.
    await expect(settleBuild({ exited: failLater(15, enoent), loaded: failLater(1, new Error("EOF")), drain: () => {}, kill: () => {}, graceMs: 200 })).rejects.toBe(enoent);
  });
});

describe("buildFailure", () => {
  const tail = [
    '#6 ERROR: process "/bin/sh -c exit 3" did not complete successfully: exit code: 3',
    'error: failed to solve: process "/bin/sh -c exit 3" did not complete successfully: exit code: 3',
  ].join("\n");

  it("makes a failed solve permanent and quotes buildctl's last lines", () => {
    const e = buildFailure(1, tail);
    expect(isPermanent(e)).toBe(true);
    expect(e.message).toContain("The build failed (buildctl exit 1)");
    expect(e.message).toContain("error: failed to solve");
  });

  it("retries only a daemon buildctl could not reach", () => {
    const e = buildFailure(1, 'error: listing workers for Build: failed to list workers: Unavailable: connection error: desc = "transport: Error while dialing: dial unix /run/buildkit/buildkitd.sock: connect: no such file or directory"');
    expect(isPermanent(e)).toBe(false);
  });

  it("says so when buildctl printed nothing", () => {
    const e = buildFailure(2, "");
    expect(isPermanent(e)).toBe(true);
    expect(e.message).toContain("printed nothing");
  });
});

describe("OutputTail", () => {
  it("keeps the last lines, skips BuildKit's rule lines and lines the log dropped", () => {
    const t = new OutputTail(3);
    for (const l of ["a", "------", "b", null, "   ", "c", "--------------------", "d"]) t.push(l);
    expect(t.text).toBe("b\nc\nd");
  });
});

describe("buildImage with a failing RUN step (end to end, buildctl faked)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dk-build-"));
    await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.20\nRUN echo $TOKEN && exit 3\n");
  });
  afterEach(async () => {
    vi.mocked(spawn).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  /** A buildctl that prints a failed solve on stderr, writes nothing to stdout and exits 1. */
  function failingBuildctl(secret: string) {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    setTimeout(() => {
      child.stderr.write("#5 [2/2] RUN echo $TOKEN && exit 3\n");
      child.stderr.write(`#5 0.211 ${secret}\n`);
      child.stderr.write('#5 ERROR: process "/bin/sh -c echo $TOKEN && exit 3" did not complete successfully: exit code: 3\n');
      child.stderr.write("------\n");
      child.stderr.write('error: failed to solve: process "/bin/sh -c echo $TOKEN && exit 3" did not complete successfully: exit code: 3\n');
      child.stderr.end();
      child.stdout.end();
      // The exit is seen after the load has already failed on the empty stream.
      setTimeout(() => child.emit("close", 1), 25);
    }, 5);
    return child;
  }

  it("fails permanently with buildctl's last lines, redacted, never with the load error", async () => {
    const secret = "s3cret-token-value-123";
    vi.mocked(spawn).mockImplementation((() => failingBuildctl(secret)) as unknown as typeof spawn);
    const docker = {
      async loadImage(tar: Readable) {
        let bytes = 0;
        for await (const c of tar) bytes += (c as Buffer).length;
        if (bytes === 0) throw new DockerError(500, "unrecognized image format");
      },
      async inspectImage() {
        throw new Error("no image was built");
      },
    } as unknown as DockerApi;
    const stored: string[] = [];
    const log = new DeployLog({ write: async (lines) => void stored.push(...lines.map((l) => l.text)) });
    const err = await failure(buildImage({ docker, buildkitAddr: "unix:///run/buildkit/buildkitd.sock" }, {
      checkoutDir: dir, rootDir: "", dockerfilePath: "", appId: "app-1", deploymentId: "dep-12345678",
      vars: [{ key: "TOKEN", value: secret, isSecret: true, target: "build" }],
      timeoutMs: 60_000,
    }, log, new AbortController().signal));
    await log.flush();

    expect(isPermanent(err)).toBe(true);
    expect(err.message).toContain("error: failed to solve");
    expect(err.message).not.toContain("unrecognized image format");
    expect(err.message).not.toContain(secret);
    expect(err.message).toContain(MARK);
    expect(stored.join("\n")).not.toContain(secret);
  });
});

describe("pullFailure and the daemon's error body", () => {
  it("fails at once on the gate's refusal of an internal registry, in its words", () => {
    const e = pullFailure("127.0.0.1:8000/x", new DockerError(400, "Dockify does not pull from 127.0.0.1: loopback"));
    expect(isPermanent(e)).toBe(true);
    expect(e.message).toContain("127.0.0.1:8000/x cannot be pulled");
    expect(e.message).toContain("loopback");
  });
  it("turns the daemon's JSON error body into its message", () => {
    expect(daemonMessage('{"message":"manifest for nginx:nope not found: manifest unknown: manifest unknown"}')).toBe("manifest for nginx:nope not found: manifest unknown: manifest unknown");
    expect(daemonMessage("plain text")).toBe("plain text");
    expect(daemonMessage("null")).toBe("null");
  });

  it("makes a missing image or tag permanent, in one sentence", () => {
    const e = pullFailure("nginx:nope", new DockerError(404, "manifest for nginx:nope not found: manifest unknown: manifest unknown"));
    expect(isPermanent(e)).toBe(true);
    expect(e.message).toBe("The image nginx:nope was not found. Check the image name and tag.");
  });

  it("makes a refused pull permanent", () => {
    const e = pullFailure("acme/private:1", new DockerError(404, "pull access denied for acme/private, repository does not exist or may require 'docker login': denied: requested access to the resource is denied"));
    expect(isPermanent(e)).toBe(true);
    expect(e.message).toContain("The registry refused to send acme/private:1");
    expect(e.message).not.toContain("{");
  });

  it("keeps a network failure retryable", () => {
    const e = pullFailure("nginx:1", new DockerError(500, "Get \"https://registry-1.docker.io/v2/\": net/http: TLS handshake timeout"));
    expect(isPermanent(e)).toBe(false);
    expect(isPermanent(pullFailure("nginx:1", new DockerError(500, "toomanyrequests: You have reached your pull rate limit")))).toBe(false);
  });

  it("pullImage fails permanently on an unknown tag", async () => {
    const docker = {
      async pullImage() {
        throw new DockerError(404, daemonMessage('{"message":"manifest for nginx:nope not found: manifest unknown: manifest unknown"}'));
      },
    } as unknown as DockerApi;
    const log = new DeployLog({ write: async () => {} });
    const err = await failure(pullImage(docker, "nginx:nope", null, log, new AbortController().signal));
    expect(isPermanent(err)).toBe(true);
    expect(err.message).toBe("The image nginx:nope was not found. Check the image name and tag.");
  });
});

describe("build variable log lines through the redactor", () => {
  it("keep every key name readable, even names that contain a keyword", () => {
    const plan = planBuild({
      buildkitAddr: "unix:///run/buildkit/buildkitd.sock", contextDir: "/b", dockerfileDir: "/b", dockerfileName: "Dockerfile",
      imageName: "dockify/app-x:1", appId: "x", deploymentId: "1",
      vars: [
        { key: "NODE_ENV", value: "production", isSecret: false, target: "build" },
        { key: "PUBLIC_TOKEN_URL", value: "https://example.com", isSecret: false, target: "both" },
        { key: "DB_PASSWORD", value: "hunter2-hunter2", isSecret: true, target: "build" },
        { key: "API_TOKEN", value: "tok-abcdef123456", isSecret: true, target: "both" },
        { key: "SECRET", value: "another-secret-value", isSecret: true, target: "build" },
      ],
    });
    const r = new Redactor().conceal(["hunter2-hunter2", "tok-abcdef123456", "another-secret-value"]);
    for (const line of planLogLines(plan)) {
      const shown = r.line(`==> ${line}`);
      expect(shown).toBe(`==> ${line}`);
      expect(shown).not.toContain(MARK);
    }
    const [args, secrets] = planLogLines(plan);
    expect(args).toBe("build args: NODE_ENV, PUBLIC_TOKEN_URL");
    expect(secrets).toContain("DB_PASSWORD, API_TOKEN, SECRET");
    // The redaction rule itself is untouched: a value after a secret-named key is still hidden.
    expect(r.line("secret: hunter3-plain")).toBe(`secret=${MARK}`);
  });
});
