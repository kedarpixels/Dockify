/**
 * The gate against hostile bytes. Everything here is a raw string, because a JS object cannot hold two
 * equal keys, and that is what the first review of this gate found: the check read a parsed copy and the
 * daemon read the bytes. Each wire case runs the real gate on a real socket in front of a fake socket proxy
 * that records exactly what reached it.
 */
import { containerSpec } from "@dockify/engine";
import { connect, createServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalBody, checkCreateBody, checkExecBody, checkNetworkBody, checkVolumeBody, createDockerGate, GateRefusal, ruleFor, type DockerGate } from "./docker-gate.ts";

const good = () => containerSpec({ name: "dk-a", image: "ghcr.io/acme/web:1", network: "dockify-env-acme", aliases: ["dk-a"], port: 3000, env: { A: "1" }, volumes: [{ name: "dk-a-data", mountPath: "/data" }], labels: { "dockify.app": "a" }, user: "1000" }, 4);
const REST = JSON.stringify(good());
const swap = (a: string | RegExp, b: string, from = REST): string => {
  const hit = typeof a === "string" ? a : a.exec(from)?.[0];
  if (!hit || !from.includes(hit)) throw new Error(`no ${String(a)} in the body`);
  return from.replace(hit, b);
};
/** The real body with its HostConfig (or another top level key) written twice. */
const twice = (key: "HostConfig" | "NetworkingConfig" | "Labels", first: unknown, last?: unknown): string => {
  const { [key]: real, ...rest } = good() as unknown as Record<string, unknown>;
  return `{${JSON.stringify(rest).slice(1, -1)},${JSON.stringify(key)}:${JSON.stringify(first)},${JSON.stringify(key)}:${JSON.stringify(last ?? real)}}`;
};
const noPrivileged = (() => {
  const { Privileged: _p, ...hc } = good().HostConfig;
  return hc;
})();
const NETWORK = '{"Name":"dockify-env-a","Driver":"bridge","Internal":false,"Attachable":false,"Labels":{},"CheckDuplicate":true,"Options":{"com.docker.network.bridge.name":"dk-0123456789ab"}}';

/** What a body comes to through the same function the gate uses. */
const through = (raw: string, check: (b: unknown) => void = checkCreateBody) => canonicalBody(Buffer.from(raw), check)?.toString("utf8");

describe("a body whose second copy is the clean one", () => {
  it.each<[string, string, (b: unknown) => void, string[]]>([
    ["HostConfig twice, privileged first", twice("HostConfig", { Privileged: true, Binds: ["/:/host"], PidMode: "host" }, noPrivileged), checkCreateBody, ["Privileged\":true", "Binds", "PidMode"]],
    ["NetworkingConfig twice, the control network first", twice("NetworkingConfig", { EndpointsConfig: { dockify_control: { IPAMConfig: { IPv4Address: "172.30.2.9" } } } }), checkCreateBody, ["dockify_control", "IPAMConfig"]],
    ["Labels twice, a Compose service first", twice("Labels", { "com.docker.compose.service": "api" }), checkCreateBody, ["\"com.docker.compose.service\":\"api\""]],
    ["Privileged twice inside a clean HostConfig", swap('"Privileged":false', '"Privileged":true,"Privileged":false'), checkCreateBody, ["Privileged\":true"]],
    ["Options twice on a network", NETWORK.replace('"Options":', '"Options":{"com.docker.network.bridge.enable_icc":"true","com.docker.network.bridge.host_binding_ipv4":"0.0.0.0"},"Options":'), checkNetworkBody, ["enable_icc", "host_binding"]],
    ["Name twice on a volume, a control volume first", '{"Name":"dockify_dockify-db","Name":"dk-x"}', checkVolumeBody, ["dockify_dockify-db"]],
    ["Privileged twice on an exec", '{"Cmd":["x"],"Tty":true,"Tty":false,"User":"root","User":"postgres"}', checkExecBody, ["root"]],
  ])("%s: only what was checked comes out", (_label, raw, check, gone) => {
    const out = through(raw, check)!;
    for (const g of gone) expect(out).not.toContain(g);
    expect(out).toBe(JSON.stringify(JSON.parse(raw)));
    // Written once each: the parsed copy and the bytes can no longer differ.
    expect(JSON.parse(out)).toEqual(JSON.parse(raw));
  });

  it.each<[string, string]>([
    ["HostConfig twice, privileged last", twice("HostConfig", noPrivileged, { ...noPrivileged, Privileged: true })],
    ["Privileged twice, true last", swap('"Privileged":false', '"Privileged":false,"Privileged":true')],
  ])("%s is refused", (_label, raw) => {
    expect(() => through(raw)).toThrow(GateRefusal);
  });
});

describe("a create body as raw text", () => {
  const cases: Array<[string, string]> = [
    // Case variants: Go matches a field whatever its case, and the last in source order wins.
    ["LogConfig with a second driver in lower case", swap('"LogConfig":{"Type":"json-file",', '"LogConfig":{"Type":"json-file","type":"syslog",')],
    ["LogConfig with a second driver in upper case and its address", swap('"max-file":"3"', '"max-file":"3","fluentd-address":"unix:///var/run/docker.sock"', swap('"LogConfig":{"Type":"json-file",', '"LogConfig":{"Type":"json-file","TYPE":"fluentd",'))],
    ["a log address beside the size cap", swap('"max-file":"3"', '"max-file":"3","syslog-address":"tcp://169.254.169.254:80"')],
    ["a larger log cap", swap('"max-size":"10m"', '"max-size":"100t"')],
    ["no log cap", swap('"max-size":"10m",', "")],
    ["RestartPolicy with its name in lower case", swap('"RestartPolicy":{"Name":"unless-stopped"}', '"RestartPolicy":{"Name":"no","name":"always"}')],
    ["RestartPolicy with retries where it has none", swap('"RestartPolicy":{"Name":"unless-stopped"}', '"RestartPolicy":{"Name":"unless-stopped","MaximumRetryCount":99}')],
    ["privileged in lower case", swap('"Privileged":false', '"privileged":true')],
    ["PRIVILEGED", swap('"Privileged":false', '"PRIVILEGED":true')],
    ["binds in lower case", swap('"Privileged":false', '"Privileged":false,"binds":["/:/h"]')],
    ["hostconfig beside HostConfig", swap('"HostConfig":', '"hostconfig":{"Privileged":true},"HostConfig":')],
    ["the Kelvin sign in a key", swap('"Privileged":false', '"Privileged":false,"\\u212aernelMemory":1')],
    ["an escaped key", swap('"Privileged":false', '"Pr\\u0069vileged":true')],
    ["an escaped key on Devices", swap('"Privileged":false', '"Privileged":false,"Devi\\u0063es":[{"PathOnHost":"/dev/sda"}]')],
    ["__proto__", swap('{"Image"', '{"__proto__":{"Privileged":true},"Image"')],
    ["an endpoint's aliases in lower case", swap('"Aliases":["dk-a"]', '"aliases":["dk-proxy"]')],
    // Nested levels, default deny.
    ["a second endpoint", swap('"EndpointsConfig":{', '"EndpointsConfig":{"dockify_control":{},')],
    ["an endpoint with an address", swap('{"Aliases":["dk-a"]}', '{"Aliases":["dk-a"],"IPAMConfig":{"IPv4Address":"172.30.3.2"}}')],
    ["a key NetworkingConfig does not have", swap('"NetworkingConfig":{', '"NetworkingConfig":{"Other":1,')],
    ["a mount with driver options", swap('"ReadOnly":false', '"ReadOnly":false,"VolumeOptions":{"DriverConfig":{"Name":"local","Options":{"device":"/"}}}')],
    ["a mount that binds", swap('"Type":"volume"', '"Type":"bind"')],
    ["a healthcheck with another key", swap('{"Image"', '{"Healthcheck":{"Test":["CMD","x"],"StartInterval":1},"Image"')],
    ["a port published by the side door", swap('"ExposedPorts":{"3000/tcp":{}}', '"ExposedPorts":{"3000/tcp":{"HostPort":"22"}}')],
    // Limits.
    ["1 PiB of memory", swap(/"Memory":\d+/, '"Memory":1125899906842624', swap(/"MemorySwap":\d+/, '"MemorySwap":1125899906842624'))],
    ["memory of 1e400", swap(/"Memory":\d+/, '"Memory":1e400')],
    ["640 cores", swap(/"NanoCpus":\d+/, '"NanoCpus":640000000000')],
    ["half a nano of CPU", swap(/"NanoCpus":\d+/, '"NanoCpus":1.5')],
    ["a CPU weight above the control plane's", swap('"CpuShares":512', '"CpuShares":262144')],
    ["no CPU weight", swap('"CpuShares":512,', "")],
    ["4e9 processes", swap('"PidsLimit":512', '"PidsLimit":4000000000')],
    ["unlimited swap", swap(/"MemorySwap":\d+/, '"MemorySwap":-1')],
    ["swap left out", swap(/"MemorySwap":\d+,/, "")],
    // Coercion: each of these used to read through String(x), or throw a TypeError that looked like a 502.
    ["a network in a list", swap('"NetworkMode":"dockify-env-acme"', '"NetworkMode":["dockify-env-acme"]')],
    ["a mount's source in a list", swap('"Source":"dk-a-data"', '"Source":["dk-a-data"]')],
    ["Mounts as an object", swap(/"Mounts":\[[^\]]*\]/, '"Mounts":{"a":1}')],
    ["CapAdd as an object", swap(/"CapAdd":\[[^\]]*\]/, '"CapAdd":{"a":1}')],
    ["Env as an object", swap(/"Env":\[[^\]]*\]/, '"Env":{"A":"1"}')],
    ["Labels with a number", swap('"dockify.managed":"true"', '"dockify.managed":true')],
    ["an alias that is an address", swap('"Aliases":["dk-a"]', '"Aliases":["172.30.3.2"]')],
    ["an image that is not a reference", swap('"Image":"ghcr.io/acme/web:1"', '"Image":"../../x y"')],
    // Reserved names.
    ["the proxy's alias", swap('"Aliases":["dk-a"]', '"Aliases":["dk-proxy"]')],
    ["the proxy's alias with a trailing dot", swap('"Aliases":["dk-a"]', '"Aliases":["dk-proxy."]')],
    ["the proxy's container name as an alias", swap('"Aliases":["dk-a"]', '"Aliases":["dockify-proxy"]')],
    ["the proxy's alias in upper case", swap('"Aliases":["dk-a"]', '"Aliases":["DK-PROXY"]')],
    // What every other part of the policy already said, now as bytes.
    ["a capability off the list", swap('"CHOWN"', '"SYS_ADMIN","CHOWN"')],
    ["CapDrop empty", swap('"CapDrop":["ALL"]', '"CapDrop":[]')],
    ["a control volume", swap('"Source":"dk-a-data"', '"Source":"dockify_dockify-db"')],
    ["a mount over /proc", swap('"Target":"/data"', '"Target":"/proc/x"')],
    ["a sysctl off the list", swap('"Privileged":false', '"Privileged":false,"Sysctls":{"kernel.core_pattern":"|/x"}')],
    ["another tmpfs", swap('"Privileged":false', '"Privileged":false,"Tmpfs":{"/x":"exec"}')],
    ["a Compose service", swap('"com.docker.compose.service":""', '"com.docker.compose.service":"api"')],
    ["nesting far past any real body", `{"Image":${"[".repeat(64)}${"]".repeat(64)}}`],
    ["not JSON", "{"],
    ["a form", "a=b"],
    ["a list", "[]"],
    ["nothing but null", "null"],
  ];
  it.each(cases)("refuses %s", (_label, raw) => {
    expect(() => through(raw)).toThrow(GateRefusal);
  });

  it("each key of HostConfig that is not containerSpec's is refused, in any case", () => {
    const keys: Array<[string, string]> = [["Binds", '["/:/h"]'], ["Devices", '[{"PathOnHost":"/dev/sda"}]'], ["DeviceCgroupRules", '["a *:* rwm"]'], ["PidMode", '"host"'], ["UTSMode", '"host"'], ["UsernsMode", '"host"'], ["CgroupnsMode", '"host"'], ["Cgroup", '"x"'], ["CgroupParent", '"/"'], ["VolumesFrom", '["x"]'], ["Links", '["x:y"]'], ["ExtraHosts", '["a:1.1.1.1"]'], ["Runtime", '"runc"'], ["Ulimits", "[]"], ["GroupAdd", '["0"]'], ["AutoRemove", "true"], ["Dns", '["1.1.1.1"]'], ["ShmSize", "1"], ["OomKillDisable", "true"], ["OomScoreAdj", "-1000"], ["MaskedPaths", "[]"], ["ReadonlyPaths", "[]"], ["Isolation", '"x"'], ["ContainerIDFile", '"/x"'], ["VolumeDriver", '"x"'], ["ConsoleSize", "[1,1]"], ["CpusetCpus", '"0"'], ["Annotations", "{}"], ["BlkioWeight", "1"], ["Capabilities", '["ALL"]']];
    for (const [k, v] of keys) {
      for (const spelled of [k, k.toLowerCase(), k.toUpperCase()]) {
        expect(() => through(swap('"Privileged":false', `"Privileged":false,"${spelled}":${v}`)), spelled).toThrow(GateRefusal);
      }
    }
  });

  it("what containerSpec writes passes with its bytes unchanged", () => {
    expect(through(REST)).toBe(REST);
  });
});

describe("the other bodies as raw text", () => {
  it.each<[string, (b: unknown) => void, string]>([
    ["a volume's driver options", checkVolumeBody, '{"Name":"dk-x","DriverOpts":{"device":"/","o":"bind","type":"none"}}'],
    ["a volume's driver options in lower case", checkVolumeBody, '{"Name":"dk-x","driveropts":{"device":"/","o":"bind","type":"none"}}'],
    ["a volume's name in a list", checkVolumeBody, '{"Name":["dk-x"]}'],
    ["a volume's labels with a number", checkVolumeBody, '{"Name":"dk-x","Labels":{"a":1}}'],
    ["a network's IPAM", checkNetworkBody, NETWORK.replace('"Driver"', '"IPAM":{"Config":[{"Subnet":"172.30.4.0/24"}]},"Driver"')],
    ["a network's ipam in lower case", checkNetworkBody, NETWORK.replace('"Driver"', '"ipam":{"Config":[{"Subnet":"172.30.4.0/24"}]},"Driver"')],
    ["a network's Internal as text", checkNetworkBody, NETWORK.replace('"Internal":false', '"Internal":"false"')],
    ["a bridge option in another case", checkNetworkBody, NETWORK.replace('"Options":{', '"Options":{"COM.DOCKER.NETWORK.BRIDGE.ENABLE_ICC":"true",')],
    ["an exec that is privileged", checkExecBody, '{"Cmd":["x"],"Privileged":true}'],
    ["an exec that is privileged in lower case", checkExecBody, '{"Cmd":["x"],"privileged":true}'],
    ["an exec that is privileged, then not", checkExecBody, '{"Cmd":["x"],"Privileged":true,"Privileged":false}'],
    ["an exec's working folder", checkExecBody, '{"Cmd":["x"],"WorkingDir":"/"}'],
    ["an exec's detach keys", checkExecBody, '{"Cmd":["x"],"DetachKeys":"a"}'],
    ["an exec's command as text", checkExecBody, '{"Cmd":"sh"}'],
    ["an exec's Tty as text", checkExecBody, '{"Cmd":["x"],"Tty":"true"}'],
  ])("refuses %s", (_label, check, raw) => {
    expect(() => through(raw, check)).toThrow(GateRefusal);
  });
});

describe("which calls pass", () => {
  const form = { "content-type": "application/x-www-form-urlencoded" };
  it.each<[string, string, string, Record<string, string>?]>([
    // A form body reopens fromSrc.
    ["a pull with a form", "POST", "/v1.43/images/create?fromImage=x", form],
    ["a pull with no query", "POST", "/v1.43/images/create"],
    ["a pull with a body", "POST", "/v1.43/images/create?fromImage=x", { "content-length": "3" }],
    ["a pull with a chunked body", "POST", "/v1.43/images/create?fromImage=x", { "transfer-encoding": "chunked" }],
    // The class: nothing but a JSON route takes a body or a Content-Type.
    ["a start with a form", "POST", "/v1.43/containers/dk-a/start", form],
    ["a stop with a form", "POST", "/v1.43/containers/dk-a/stop?t=1", form],
    ["a stop with a body", "POST", "/v1.43/containers/dk-a/stop", { "content-length": "3" }],
    ["a kill with a form", "POST", "/v1.43/containers/dk-a/kill", form],
    ["a wait with a body", "POST", "/v1.43/containers/dk-a/wait", { "content-length": "20" }],
    ["a resize with a form", "POST", `/v1.43/exec/${"a".repeat(64)}/resize?h=1&w=1`, form],
    ["an attach with a form, which reads its options from one", "POST", "/v1.43/containers/dk-a/attach?stream=1&stdout=1&stderr=1&stdin=0", form],
    ["a create with a form", "POST", "/v1.43/containers/create?name=dk-a", form],
    ["an exec with another JSON-like type", "POST", "/v1.43/containers/dk-a/exec", { "content-type": "text/plain" }],
    ["a GET with a body", "GET", "/v1.43/containers/json", { "content-length": "5" }],
    ["a DELETE with a body", "DELETE", "/v1.43/containers/dk-a?force=true&v=false", { "content-length": "5" }],
    // No caller, and the one body nothing read.
    ["an image load", "POST", "/v1.43/images/load?quiet=true"],
    ["an image load with a tar", "POST", "/v1.43/images/load", { "content-type": "application/x-tar" }],
    // Only what the worker itself deletes.
    ["deleting the proxy's tag", "DELETE", "/v1.43/images/traefik%3Av3.5.3?noprune=false"],
    ["deleting an image by a short id", "DELETE", "/v1.43/images/sha256%3Aabc?noprune=false"],
    ["deleting by a tag that is not a build's", "DELETE", "/v1.43/images/dockify%2Fcontrol%3A1?noprune=false"],
    // A side door to a reserved name, any spelling.
    ["a create named dk-proxy", "POST", "/v1.43/containers/create?name=dk-proxy"],
    ["a create named dk-PROXY", "POST", "/v1.43/containers/create?name=dk-PROXY"],
    ["a create named DK-proxy", "POST", "/v1.43/containers/create?name=DK-proxy"],
    ["a create named dk-proxy.", "POST", "/v1.43/containers/create?name=dk-proxy."],
    ["a rename to dk-proxy", "POST", "/v1.43/containers/dk-a/rename?name=dk-proxy"],
    ["a rename to dk-PROXY", "POST", "/v1.43/containers/dk-a/rename?name=dk-PROXY"],
    // An image's name may hold an encoded slash, but never walk.
    ["an image delete that walks", "DELETE", "/v1.43/images/..%2f..%2fcontainers%2fdockify-worker?noprune=false"],
    ["an image read that walks", "GET", "/v1.43/images/..%2f..%2fcontainers%2fdockify-worker/json"],
    ["an image read that walks in upper case", "GET", "/v1.43/images/..%2F..%2Fcontainers%2Fdockify-worker/json"],
    ["an image read with a NUL", "GET", "/v1.43/images/x%00/json"],
  ])("refuses %s", (_label, method, url, headers) => {
    expect(() => ruleFor(method, url, headers)).toThrow(GateRefusal);
  });

  it("every hostile path and query", () => {
    const H = "a".repeat(64);
    const refused: Array<[string, string]> = [
      ["PUT", "/v1.43/containers/dk-a/archive?path=/"], ["GET", "/v1.43/containers/dk-a/archive?path=/"], ["HEAD", "/v1.43/containers/dk-a/archive?path=/"],
      ["POST", "/v1.43/containers/dk-a/update"], ["POST", "/v1.43/containers/dk-a/commit"], ["POST", "/v1.43/commit?container=dk-a"], ["GET", "/v1.43/containers/dk-a/export"],
      ["POST", "/v1.43/containers/dk-a/pause"], ["POST", "/v1.43/containers/dk-a/restart"], ["GET", "/v1.43/containers/dk-a/top"], ["GET", "/v1.43/containers/dk-a/changes"],
      ["POST", "/v1.43/build"], ["POST", "/v1.43/session"], ["POST", "/v1.43/images/x/tag?repo=y"], ["POST", "/v1.43/images/x/push"], ["GET", "/v1.43/images/x/get"], ["POST", "/v1.43/images/prune"],
      ["POST", "/v1.43/containers/prune"], ["POST", "/v1.43/volumes/prune"], ["POST", "/v1.43/networks/prune"], ["GET", "/v1.43/plugins"], ["POST", "/v1.43/plugins/pull"], ["POST", "/v1.43/swarm/init"], ["POST", "/v1.43/auth"],
      ["GET", "/v1.43/info"], ["GET", "/v1.43/version"], ["GET", "/_ping"], ["GET", "/v1.43/volumes"], ["GET", "/v1.43/volumes/dk-x"], ["GET", "/v1.43/events"], ["GET", "/v1.43/networks"], ["GET", "/v1.43/system/df"], ["POST", "/v1.43/grpc"],
      ["post", "/v1.43/containers/create"], ["GeT", "/v1.43/containers/json"], ["GET", "/V1.43/containers/json"], ["GET", "/v2.0/containers/json"], ["GET", "/v1.43/v1.43/containers/json"], ["GET", "//containers/json"], ["GET", "/containers//json"], ["GET", "/containers/json/"],
      ["GET", "http://x/containers/json"], ["GET", "/containers/json#x"], ["GET", "/containers/x/json?size=1"],
      ["POST", "/v1.43/containers/%2e%2e/start"], ["POST", "/v1.43/containers/x/../y/start"], ["POST", "/v1.43/containers/dockify-worker/../dk-a/start"], ["POST", "/v1.43/containers/dk-x%2fconfig/start"], ["POST", "/v1.43/containers/dk-x%5cconfig/start"],
      ["DELETE", "/v1.43/volumes/dk-x%2f..%2fy"], ["DELETE", "/v1.43/volumes/dockify_dockify-db"], ["DELETE", "/v1.43/volumes/dockify-data-"], ["DELETE", "/v1.43/networks/dockify_control"], ["DELETE", "/v1.43/networks/dockify-deploy"],
      ["POST", "/v1.43/networks/dockify_control/connect"], ["POST", "/v1.43/networks/dockify-deploy/connect"], ["POST", "/v1.43/networks/dockify_docker-api/disconnect"], ["POST", "/v1.43/networks/%64ockify_control/connect"],
      ["POST", "/v1.43/containers/dockify-worker/exec"], ["POST", `/v1.43/containers/${H}/exec`], ["POST", "/v1.43/containers/dockify-worker/attach"], ["POST", "/v1.43/containers/%64k-a/exec"], ["POST", "/v1.43/containers/dk-a%2f..%2fdockify-worker/exec"],
      ["POST", "/v1.43/containers/dockify-worker/rename?name=dk-x"], ["POST", "/v1.43/containers/dk-a/rename?name=dockify-worker"], ["POST", "/v1.43/containers/dk-a/rename?name=dk-b&name=dockify-worker"], ["POST", "/v1.43/containers/dk-a/rename"],
      ["POST", "/v1.43/containers/create?name=dockify-worker"], ["POST", "/v1.43/containers/create?name=dk-a&platform=x"], ["POST", "/v1.43/containers/create?name=dk-a&name=dockify-api"], ["POST", "/v1.43/containers/create"],
      ["POST", "/v1.43/images/create?fromSrc=-&repo=x"], ["POST", "/v1.43/images/create?fromImage=x&fromSrc=-"], ["POST", "/v1.43/images/create?fromImage=x&repo=y"], ["POST", "/v1.43/images/create?fromImage=x&platform=y"], ["POST", "/v1.43/images/create?fromImage=x%26fromSrc%3D-"], ["POST", "/v1.43/images/create?fromImage=x;fromSrc=-"],
      ["POST", "/v1.43/images/load?quiet=1"], ["POST", "/v1.43/images/load?quiet=0"],
      ["DELETE", "/v1.43/images/x?force=true"], ["DELETE", "/v1.43/images/x?noprune=true"], ["DELETE", "/v1.43/images/traefik%3Av3.5.3"],
      ["DELETE", "/v1.43/containers/dk-a?force=true"], ["DELETE", "/v1.43/containers/dk-a?force=true&v=true&link=true"], ["DELETE", "/v1.43/containers/dk-a?link=true"],
      ["POST", "/v1.43/containers/dk-a/wait?condition=removed"], ["POST", "/v1.43/containers/dk-a/kill?signal=sigkill"], ["POST", "/v1.43/containers/dk-a/stop?t=1&signal=x"],
      ["POST", "/v1.43/containers/dk-a/attach?stream=1&stdout=1&stderr=1&stdin=1&logs=1"], ["POST", "/v1.43/containers/dk-a/attach?detachKeys=x"],
      ["POST", `/v1.43/exec/${H}/resize`], ["POST", "/v1.43/exec/x/resize?h=1&w=1"], ["GET", "/v1.43/exec/x/json?x=1"],
      ["GET", "/v1.43/events?filters=%7B%7D"], ["GET", "/v1.43/networks?filters=%7B%7D"],
    ];
    for (const [method, url] of refused) expect(() => ruleFor(method, url), `${method} ${url}`).toThrow(GateRefusal);
  });

  it("a Content-Length of 0 is no body, as node:http sends with an empty POST", () => {
    expect(() => ruleFor("POST", "/v1.43/containers/dk-a/start", { "content-length": "0" })).not.toThrow();
  });
});

describe("the gate on a real socket", () => {
  interface Seen {
    head: string;
    body: string;
  }
  const ID = "b".repeat(64);
  let upstream: NetServer;
  let gate: DockerGate;
  let front: NetServer;
  let reached: Seen[] = [];

  const headEnd = (s: string): number => s.indexOf("\r\n\r\n");
  beforeAll(async () => {
    // A proxy that keeps framing as HTTP does, and answers an upgrade with a 101.
    upstream = createServer((s: Socket) => {
      let buf = "";
      s.on("error", () => {});
      s.on("data", (d: Buffer) => {
        buf += d.toString("latin1");
        for (;;) {
          const end = headEnd(buf);
          if (end === -1) return;
          const head = buf.slice(0, end);
          const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
          if (buf.length < end + 4 + length) return;
          const body = buf.slice(end + 4, end + 4 + length);
          buf = buf.slice(end + 4 + length);
          if (/^GET [^ ]*\/containers\/[^/ ]+\/json/.test(head)) {
            const info = JSON.stringify({ Id: ID, Config: { Labels: { "dockify.managed": "true" }, Env: ["A=1"] } });
            s.write(`HTTP/1.1 200 OK\r\nContent-Length: ${info.length}\r\nConnection: close\r\n\r\n${info}`);
            continue;
          }
          reached.push({ head, body });
          if (/upgrade: tcp/i.test(head)) s.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
          else s.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        }
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    gate = createDockerGate({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port });
    front = createServer((s) => gate.handle(s));
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    gate.close();
    front.close();
    upstream.close();
  });
  beforeEach(() => {
    reached = [];
  });

  const send = (raw: string, ms = 150): Promise<string> =>
    new Promise((resolve) => {
      const c = connect((front.address() as AddressInfo).port, "127.0.0.1");
      let got = "";
      c.on("data", (d) => (got += d.toString("latin1")));
      c.on("error", () => {});
      c.write(raw);
      setTimeout(() => {
        c.destroy();
        resolve(got);
      }, ms);
    });
  const req = (method: string, url: string, headers: string[], body = ""): string => `${method} ${url} HTTP/1.1\r\nHost: x\r\n${headers.map((h) => `${h}\r\n`).join("")}\r\n${body}`;
  const post = (url: string, body: string, type = "application/json"): string => req("POST", url, [`Content-Type: ${type}`, `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close"], body);

  describe("what reaches the socket proxy is the canonical form, on every route that takes a body", () => {
    const hostile = (json: string) => `  \n${json.replace(/,/, " ,\n ")}\t `;
    const execStart = `/v1.43/exec/${"a".repeat(64)}/start`;
    it.each<[string, string, string]>([
      ["a create", "/v1.43/containers/create?name=dk-a", REST],
      ["an exec", "/v1.43/containers/dk-a/exec", '{"AttachStdout":true,"AttachStderr":true,"AttachStdin":false,"Tty":false,"Cmd":["pg_dump"],"Env":["A=1"],"User":"postgres"}'],
      ["a detached exec start", execStart, '{"Detach":true,"Tty":false}'],
      ["a network", "/v1.43/networks/create", NETWORK],
      ["a connect", "/v1.43/networks/dockify-env-a/connect", '{"Container":"dk-a"}'],
      ["a disconnect", "/v1.43/networks/dockify-env-a/disconnect", '{"Container":"dk-a","Force":true}'],
      ["a volume", "/v1.43/volumes/create", '{"Name":"dk-x","Labels":{"a":"b"}}'],
      ["an attach, without an upgrade", "/v1.43/containers/dk-a/attach?stream=1&stdout=1&stderr=1&stdin=0", "{}"],
    ])("%s", async (_label, url, json) => {
      await send(post(url, hostile(json)));
      expect(reached).toHaveLength(1);
      const body = JSON.stringify(JSON.parse(json));
      expect(reached[0]!.body).toBe(body);
      expect(reached[0]!.head).toMatch(/^content-type: application\/json$/im);
      expect(reached[0]!.head).toMatch(new RegExp(`^content-length: ${Buffer.byteLength(body)}$`, "im"));
    });

    it("C1 on the wire: the privileged copy never reaches it", async () => {
      await send(post("/v1.43/containers/create?name=dk-a", twice("HostConfig", { Privileged: true, Binds: ["/:/host"], PidMode: "host" }, noPrivileged)));
      expect(reached).toHaveLength(1);
      expect(reached[0]!.body).not.toContain("Binds");
      expect(reached[0]!.body).not.toContain("PidMode");
      expect(reached[0]!.body.match(/"HostConfig"/g)).toHaveLength(1);
      expect(JSON.parse(reached[0]!.body).HostConfig).toEqual(noPrivileged);
    });

    it("C1 on the tunnel: the same on an exec start that upgrades", async () => {
      const raw = '{"Detach":false,"Tty":true,"Tty":false,"Detach":false}';
      await send(req("POST", execStart, ["Connection: Upgrade", "Upgrade: tcp", "Content-Type: application/json", `Content-Length: ${raw.length}`], raw));
      expect(reached).toHaveLength(1);
      expect(reached[0]!.body).toBe('{"Detach":false,"Tty":false}');
      expect(reached[0]!.head).toMatch(/^Content-Length: 28$/im);
    });

    it("a chunked body is framed again, and its Transfer-Encoding stops here", async () => {
      const chunk = `${(2).toString(16)}\r\n{}\r\n0\r\n\r\n`;
      await send(req("POST", "/v1.43/containers/dk-a/attach?stream=1&stdout=1&stderr=1&stdin=0", ["Transfer-Encoding: chunked", "Content-Type: application/json", "Connection: close"], chunk));
      expect(reached).toHaveLength(1);
      expect(reached[0]!.body).toBe("{}");
      expect(reached[0]!.head).not.toMatch(/transfer-encoding/i);
    });

    it("a header off the list stops here, and a registry's credential goes only with a pull", async () => {
      await send(req("GET", "/v1.43/containers/json", ["X-Forwarded-For: 1", "Cookie: a", "X-Registry-Auth: secret", "Connection: close"]));
      expect(reached).toHaveLength(1);
      expect(reached[0]!.head).not.toMatch(/forwarded|cookie|registry/i);
      reached = [];
      await send(req("POST", "/v1.43/images/create?fromImage=x", ["X-Registry-Auth: secret", "Connection: close"]));
      expect(reached).toHaveLength(1);
      expect(reached[0]!.head).toMatch(/^x-registry-auth: secret$/im);
    });
  });

  describe("nothing reaches the socket proxy for", () => {
    const form = "fromImage=&fromSrc=http%3A%2F%2F169.254.169.254%2Flatest%2Fx.tar&repo=docker.io%2Flibrary%2Ftraefik&tag=v3.5.3&changes=ENTRYPOINT+x";
    const smug = (() => {
      const b = '{"HostConfig":{"Privileged":true}}';
      return req("POST", "/v1.43/containers/create", [`Content-Length: ${b.length}`], b);
    })();
    const upgrade = ["Connection: Upgrade", "Upgrade: tcp"];
    const attach = "/v1.43/containers/dk-a/attach?stream=1&stdout=1&stderr=1&stdin=0";
    it.each<[string, string]>([
      ["H3: a pull with a form body", post("/v1.43/images/create?fromImage=x", form, "application/x-www-form-urlencoded")],
      ["H3: the same with no query", post("/v1.43/images/create", form, "application/x-www-form-urlencoded")],
      ["H3: a pull with a body and no Content-Type", req("POST", "/v1.43/images/create?fromImage=x", [`Content-Length: ${form.length}`, "Connection: close"], form)],
      ["H3 on the upgrade path: attach under a form", req("POST", attach, [...upgrade, "Content-Type: application/x-www-form-urlencoded", "Content-Length: 6"], "logs=1")],
      ["an image load", req("POST", "/v1.43/images/load?quiet=1", ["Content-Length: 3", "Connection: close"], "tar")],
      ["a create under a form", post("/v1.43/containers/create?name=dk-a", REST, "application/x-www-form-urlencoded")],
      ["a stop with a form body", post("/v1.43/containers/dk-a/stop", "t=1", "application/x-www-form-urlencoded")],
      ["L6: a GET with a Content-Length", req("GET", "/v1.43/containers/json", ["Content-Length: 5"], "hello")],
      ["L6: a DELETE with a Content-Length", req("DELETE", "/v1.43/containers/dk-a?force=true&v=false", ["Content-Length: 5"], "hello")],
      ["CL with TE", req("POST", "/v1.43/containers/create", ["Content-Length: 4", "Transfer-Encoding: chunked"], `0\r\n\r\n${smug}`)],
      ["a smuggled create after the last chunk", req("POST", "/v1.43/containers/dk-a/start", ["Transfer-Encoding: chunked"], `3\r\ntar\r\n0\r\n\r\n${smug}`)],
      ["TE by a tab, with a length", req("POST", "/v1.43/containers/create", ["Content-Length: 3", "Transfer-Encoding:\tchunked"], "tar")],
      ["xchunked, with a length", req("POST", "/v1.43/containers/create", ["Content-Length: 3", "Transfer-Encoding: xchunked"], "tar")],
      ["identity, with a length", req("POST", "/v1.43/containers/create", ["Content-Length: 3", "Transfer-Encoding: identity"], "tar")],
      ["an obsolete folded header", req("POST", "/v1.43/containers/create", ["Content-Length: 3", "X-Registry-Auth: a", "  b: c"], "tar")],
      ["a target with spaces", "GET /v1.43/containers/json HTTP/1.1 x HTTP/1.1\r\nHost: x\r\n\r\n"],
      ["two lengths", req("POST", "/v1.43/containers/create", ["Content-Length: 3", "Content-Length: 300"], "tar")],
      ["a list of lengths", req("POST", "/v1.43/containers/create", ["Content-Length: 3, 3"], "tar")],
      ["a signed length", req("POST", "/v1.43/containers/create", ["Content-Length: +3"], "tar")],
      ["a space before a colon", req("POST", "/v1.43/containers/create", ["Content-Length: 3", "Transfer-Encoding : chunked"], "tar")],
      ["a bare LF in a header on the upgrade path", `POST ${attach} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nX-Registry-Auth: a\nX-Evil: 1\r\n\r\n`],
      ["a bare CR in a header on the upgrade path", `POST ${attach} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nX-Registry-Auth: a\rPOST /x HTTP/1.1\r\n\r\n`],
      ["a bare LF in the request line", "GET /v1.43/containers/json\nX HTTP/1.1\r\nHost: x\r\n\r\n"],
      ["a lower case method", "post /v1.43/containers/create HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n"],
      ["CONNECT", "CONNECT 172.30.4.2:2375 HTTP/1.1\r\nHost: x\r\n\r\n"],
      ["an upgrade on a list", req("GET", "/v1.43/containers/json", upgrade) + smug],
      ["an upgrade on a create", req("POST", "/v1.43/containers/create", [...upgrade, "Content-Length: 2"], "{}")],
      ["L4: an upgrade on a container start", req("POST", "/v1.43/containers/dk-a/start", [...upgrade, "Content-Length: 0"]) + smug],
      ["L4: an upgrade on a delete of a container named start", req("DELETE", "/v1.43/containers/start?force=true&v=false", upgrade)],
      ["a chunked exec start on upgrade", req("POST", `/v1.43/exec/${"a".repeat(64)}/start`, [...upgrade, "Transfer-Encoding: chunked"], `2\r\n{}\r\n0\r\n\r\n${smug}`)],
      ["a refused call, then more bytes", req("POST", "/v1.43/build", ["Content-Length: 0"]) + smug],
    ])("%s", async (_label, raw) => {
      await send(raw);
      expect(reached).toEqual([]);
    });
  });

  it("a request behind an allowed one is checked on its own: the raw create never arrives", async () => {
    const b = '{"HostConfig":{"Privileged":true}}';
    await send(req("GET", "/v1.43/containers/json", []) + req("POST", "/v1.43/containers/create", [`Content-Length: ${b.length}`], b));
    expect(reached.filter((r) => r.head.includes("containers/create"))).toEqual([]);
  });

  it("the bytes after an attach's body wait for the 101, and are the process's stdin", async () => {
    const attach = "/v1.43/containers/dk-a/attach?stream=1&stdout=1&stderr=1&stdin=1";
    const got = await send(req("POST", attach, ["Connection: Upgrade", "Upgrade: tcp", "Content-Type: application/json", "Content-Length: 2"], "{}"));
    expect(got).toContain("101");
    expect(reached).toHaveLength(1);
    expect(reached[0]!.body).toBe("{}");
  });

  it("a refusal says so, and a body under a bad type is a 400, not a server error", async () => {
    const got = await send(post("/v1.43/images/create?fromImage=x", "fromSrc=x", "application/x-www-form-urlencoded"));
    expect(got).toMatch(/^HTTP\/1\.1 400 /);
    const typed = await send(post("/v1.43/containers/create?name=dk-a", swap(/"Mounts":\[[^\]]*\]/, '"Mounts":{"a":1}')));
    expect(typed).toMatch(/^HTTP\/1\.1 400 /);
  });

  it("every body being read at once is bounded", async () => {
    const small = createDockerGate({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port }, { maxBuffered: 16 });
    const f = createServer((s) => small.handle(s));
    await new Promise<void>((r) => f.listen(0, "127.0.0.1", r));
    const c = connect((f.address() as AddressInfo).port, "127.0.0.1");
    const closed = new Promise<void>((resolve) => c.on("close", () => resolve()));
    c.on("error", () => {});
    c.on("data", () => {});
    c.write(post("/v1.43/volumes/create", '{"Name":"dk-a-long-enough-name-to-pass-the-limit"}'));
    await closed;
    expect(reached).toEqual([]);
    small.close();
    f.close();
  });
});
