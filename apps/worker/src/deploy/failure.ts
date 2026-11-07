/**
 * Why a container did not come up, in words the deploy log can show. "Crash-looping" alone
 * sent owners to the server to find out that the image had no shell: the reason is in the
 * container's own last output and exit code, and the program it could not run is worth naming.
 *
 * Containers run under docker-init (HostConfig.Init), so a program that cannot be run is not a
 * refused start: init itself starts, prints "exec X failed: No such file or directory" and exits
 * 127, or 126 for a file that is not executable.
 */
import { plainWords } from "./containers.ts";
import { Demuxer, type ContainerInfo, type DockerApi } from "@dockify/engine";

/** Lines of the container's output quoted in the failure. */
const TAIL_LINES = 5;
const TAIL_CHARS = 800;

/** What the runtime says when it cannot run the named program. */
const RUNTIME_CANNOT_RUN = /executable file not found|exec format error|exec:\s+"[^"]*":|no such file or directory|permission denied/i;
/** What init says when it cannot run the named program. */
const INIT_CANNOT_RUN = /\bexec\s+\S+\s+failed:/;
/** The program named by either message, when it names one. */
const NAMED = /\bexec\s+(\S+)\s+failed:|exec:\s+"([^"]+)":/;

/** The last lines the container wrote, redacted. Best effort: empty when they cannot be read. */
export async function lastOutput(docker: DockerApi, id: string, redact: (line: string) => string = (l) => l): Promise<string[]> {
  try {
    const stream = await docker.logs(id, false);
    const demux = new Demuxer();
    let text = "";
    for await (const chunk of stream) {
      demux.push(chunk as Buffer, (_k, d) => {
        text = (text + d.toString("utf8")).slice(-64 * 1024);
      });
    }
    return text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).slice(-TAIL_LINES).map(redact);
  } catch {
    return [];
  }
}

export interface FailureFacts {
  /** The start or release command the container ran, when it had one. */
  command: string | null;
  exitCode: number | null;
  /** Docker's own State.Error. */
  stateError: string | null;
  output: string[];
}

/** The command could not even begin: its program is missing or not executable, so nothing of it ran. */
export function couldNotRun(f: Pick<FailureFacts, "exitCode" | "stateError" | "output">): boolean {
  if (f.stateError && RUNTIME_CANNOT_RUN.test(f.stateError)) return true;
  // 127 and 126 alone can also be the program's own exit, so init's own line must say so too.
  return (f.exitCode === 127 || f.exitCode === 126) && f.output.some((l) => INIT_CANNOT_RUN.test(l));
}

/** One or two sentences for the deploy log and the failure message; empty when nothing is known. */
export function explainFailure(f: FailureFacts): string {
  const parts: string[] = [];
  if (couldNotRun(f)) {
    const named = [f.stateError ?? "", ...f.output].map((l) => NAMED.exec(l)).find(Boolean);
    const program = named?.[1] ?? named?.[2] ?? null;
    if (f.command && !plainWords(f.command)) {
      parts.push("This image has no shell, and the command uses shell syntax, which needs one. Write it as a plain command, with no quotes, variables or operators, or use an image with sh.");
    } else if (program) {
      parts.push(`${program} is not a program this image can run. Check the command, or clear it to run the image as built.`);
    } else {
      parts.push("The command is not a program this image can run. Check the command, or clear it to run the image as built.");
    }
  }
  if (f.stateError) parts.push(`Docker said: ${f.stateError.slice(0, 300)}.`);
  if (f.output.length) parts.push(`Its last output: ${f.output.join(" | ").slice(0, TAIL_CHARS)}`);
  else if (f.exitCode) parts.push(`It exited with code ${f.exitCode} and wrote nothing.`);
  return parts.join(" ");
}

/** The facts of one failed container, from its last inspect and its logs. */
export async function failureFacts(
  docker: DockerApi,
  id: string,
  o: { command: string | null; info: ContainerInfo | null; exitCode?: number | null; redact?: (line: string) => string },
): Promise<FailureFacts> {
  return {
    command: o.command,
    exitCode: o.exitCode ?? (o.info?.State.ExitCode || null),
    stateError: o.info?.State.Error?.trim() || null,
    output: await lastOutput(docker, id, o.redact),
  };
}
