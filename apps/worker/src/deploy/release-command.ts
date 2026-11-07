/**
 * The release step: a one-off container from the pinned image runs the app's release command
 * (migrations) once, before any swap. Exit 0 or the deploy stops with nothing swapped. A non-zero
 * exit and a timeout are permanent: re-running a migration that was killed mid-way is worse than
 * failing. The run-once marker is the "release" step in Deployment.steps, set by the caller.
 */
import type { DockerApi } from "@dockify/engine";
import { isNotFound } from "@dockify/engine";
import { Demuxer } from "@dockify/engine";
import type { ContainerInput } from "@dockify/engine";
import { appContainerInput, imageArguments, releaseName, type RunnableApp } from "./containers.ts";
import { DeployCancelled, PermanentDeployError } from "@dockify/engine";
import { couldNotRun, explainFailure, failureFacts } from "./failure.ts";
import type { DeployLog } from "./log.ts";
import { hasEntrypoint } from "./swap.ts";

export async function runReleaseCommand(
  docker: DockerApi,
  app: RunnableApp,
  o: {
    command: string; imageId: string; env: Record<string, string>; deploymentId: string; timeoutMs: number;
    /** A preview's own container input (previewReleaseInput); left out, the app's. */
    input?: (name: string, command: string) => ContainerInput;
  },
  log: DeployLog,
  signal: AbortSignal,
): Promise<void> {
  const name = releaseName(app.id, o.deploymentId);
  // A leftover from a crashed attempt of this same deployment.
  await docker.removeContainer(name, { volumes: true }).catch(() => {});
  log.system(`running the release command in one-off container ${name}`);
  log.system(`$ ${o.command}`);
  const input = o.input ? o.input(name, o.command) : appContainerInput(app, { name, imageId: o.imageId, env: o.env, deploymentId: o.deploymentId, role: "release", cmd: o.command });
  let out = await runOnce(docker, name, input, o, log, signal);
  // A command saved before commands replaced the entrypoint: nothing of it ran, so it is safe to try
  // as arguments to the image's own entrypoint. A command that did run is never run twice.
  const asArguments = out.ok || !out.notRun ? null : imageArguments(o.command);
  if (asArguments && (await hasEntrypoint(docker, o.imageId))) {
    log.system(`${asArguments.cmd[0]} is not a program in this image, so the command goes to the image's own entrypoint as arguments`);
    const { entrypoint: _replaced, ...rest } = input;
    out = await runOnce(docker, name, { ...rest, ...asArguments }, o, log, signal);
  }
  if (!out.ok) throw new PermanentDeployError(out.message);
}

type Outcome = { ok: true } | { ok: false; notRun: boolean; message: string };

/** One run of the one-off, removed whatever happens. Throws only for a cancel, a timeout or a daemon error. */
async function runOnce(
  docker: DockerApi,
  name: string,
  input: ContainerInput,
  o: { command: string; timeoutMs: number },
  log: DeployLog,
  signal: AbortSignal,
): Promise<Outcome> {
  const id = await docker.createContainer(name, input);
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const both = AbortSignal.any([signal, timeout]);
  try {
    await docker.startContainer(id);
    const drained = drain(docker, id, log);
    let code: number;
    try {
      code = await docker.waitContainer(id, both);
    } catch (e) {
      await docker.stopContainer(id, 10).catch(() => {});
      await drained;
      if (signal.aborted) throw new DeployCancelled();
      if (timeout.aborted) throw new PermanentDeployError(`the release command was still running after ${Math.round(o.timeoutMs / 1000)}s and was stopped; nothing was swapped`);
      throw e;
    }
    await drained;
    if (code !== 0) {
      const info = await docker.inspectContainer(id).catch(() => null);
      const facts = await failureFacts(docker, id, { command: o.command, info, exitCode: code, redact: (l) => log.redactor.line(l) });
      // Its output is already in the log above, so only a command that could not run gets a reason.
      const why = couldNotRun(facts) ? explainFailure(facts) : "";
      if (why) log.error(why);
      return { ok: false, notRun: couldNotRun(facts), message: `the release command exited with code ${code}; nothing was swapped${why ? `. ${why}` : ""}` };
    }
    log.system("release command finished");
    return { ok: true };
  } finally {
    await docker.removeContainer(id, { volumes: true }).catch((e) => {
      if (!isNotFound(e)) log.error(`could not remove the release container: ${(e as Error).message}`);
    });
  }
}

async function drain(docker: DockerApi, id: string, log: DeployLog): Promise<void> {
  try {
    const stream = await docker.logs(id, true);
    const demux = new Demuxer();
    const out = log.splitter("stdout");
    const err = log.splitter("stderr");
    for await (const chunk of stream) demux.push(chunk as Buffer, (s, d) => (s === "stderr" ? err : out).push(d.toString("utf8")));
    out.end();
    err.end();
  } catch {
    // Output is diagnostic only.
  }
}
