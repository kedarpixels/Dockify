/**
 * Every Docker call the worker makes, and calls nothing in Dockify may make. Two tests read these: the
 * socket proxy's allowlist and the agent's gate must both agree with them. Never shipped in an image.
 */
export function dockerCalls(canonicalName: (appId: string) => string, START_EVENTS_PATH: string) {
  const APP_ID = "0f0e0d0c-0000-4000-8000-0000000000aa";
  const ENV_ID = "0f0e0d0c-0000-4000-8000-0000000000bb";
  const LIVE = canonicalName(APP_ID);
  const PARKED = `${LIVE}-prev-mh3k2x1q`;
  const HEX_ID = "0123456789abcdef".repeat(4);
  
  /** Every Docker call the worker makes (packages/engine/src/docker.ts, data/engine-port.ts, observe/docker.ts, deploy/disk.ts), with /v1.43 as the worker sends it. */
  const USED: Array<[string, string, Record<string, string>?]> = [
    ["GET", "/v1.43/containers/json"],
    ["GET", "/v1.43/containers/dk-abc/json"],
    ["GET", "/v1.43/containers/dk-abc/logs"],
    ["GET", "/v1.43/containers/0123456789ab/stats"],
    ["GET", "/v1.43/images/json"],
    ["GET", "/v1.43/images/ghcr.io%2Forg%2Frepo%3A1.2/json"],
    ["GET", "/v1.43/images/sha256%3Aabc/json"],
    ["GET", "/v1.43/networks/dockify-env-abc"],
    ["GET", "/v1.43/exec/0123456789abcdef/json"],
    ["POST", "/v1.43/containers/create?name=dk-abc"],
    ["POST", "/v1.43/containers/dk-abc/start"],
    ["POST", "/v1.43/containers/dk-abc/stop"],
    ["POST", "/v1.43/containers/dk-abc/kill"],
    // the swap parks the live container and gives the name back on a rollback, both by name
    ["POST", `/v1.43/containers/${LIVE}/rename?name=${PARKED}`],
    ["POST", `/v1.43/containers/${PARKED}/rename?name=${LIVE}`],
    ["POST", "/v1.43/containers/dk-abc/wait"],
    ["POST", "/v1.43/containers/dk-abc/attach"],
    ["POST", "/v1.43/containers/dk-abc/exec"],
    ["POST", "/v1.43/containers/dockify-rt-abc/exec"],
    ["POST", "/v1.43/containers/dockify-bk-abc/attach"],
    ["POST", "/v1.43/containers/dockify-rs-abc/attach"],
    ["POST", "/v1.43/exec/0123456789abcdef/start"],
    // the web terminal's window size (terminal/engine.ts); its exec and start are the two rows above
    ["POST", `/v1.43/exec/${HEX_ID}/resize?h=40&w=120`],
    ["DELETE", "/v1.43/containers/dk-abc"],
    ["POST", "/v1.43/images/create?fromImage=ghcr.io%2Forg%2Frepo%3A1.2"],
    ["DELETE", "/v1.43/images/dockify%2Fapp-abc%3A1234"],
    ["POST", "/v1.43/networks/create"],
    ["POST", "/v1.43/networks/dockify-env-abc/connect"],
    ["POST", "/v1.43/networks/dockify-env-abc/disconnect"],
    // deploy/networks.ts: the sweep of environment networks nothing needs any more
    ["GET", `/v1.43/networks?filters=${encodeURIComponent(JSON.stringify({ name: ["dockify-env-"] }))}`],
    ["DELETE", `/v1.43/networks/dockify-env-${ENV_ID}`],
    // deploy/networks.ts: a preview's own network, when the preview goes
    ["GET", `/v1.43/networks?filters=${encodeURIComponent(JSON.stringify({ name: ["dockify-pv-"] }))}`],
    ["DELETE", `/v1.43/networks/dockify-pv-${ENV_ID}`],
    ["POST", "/v1.43/volumes/create"],
    ["DELETE", "/v1.43/volumes/dockify-data-abc"],
    ["DELETE", "/v1.43/volumes/dk-abc123-pgdata"],
    // data/leftovers.ts: a restore test's scratch volume, and anonymous volumes proven to hold nothing of anyone's
    ["DELETE", `/v1.43/volumes/dk-rt-${APP_ID}`],
    ["DELETE", `/v1.43/volumes/${HEX_ID}`],
    // deploy/disk.ts: the timer's full sample, and the quick one a prune takes after it removes images
    ["GET", "/v1.43/system/df?type=image&type=volume"],
    ["GET", "/v1.43/system/df?type=image"],
    // edge/starts.ts follows start events of Dockify's own containers
    ["GET", `/v1.43${START_EVENTS_PATH}`],
    // observe/docker.ts sends no version prefix
    ["GET", "/containers/json"],
    ["GET", "/containers/0123456789ab/json"],
    ["GET", "/containers/0123456789ab/logs"],
  ];
  
  /** Through the socket proxy from the agent's own client, after a build. Never through the gate. */
  const AGENT_ONLY: Array<[string, string, Record<string, string>?]> = [
    ["POST", "/v1.43/images/load?quiet=true", { "content-type": "application/x-tar" }],
  ];

  /** Calls that would widen a worker compromise and that nothing in Dockify makes. */
  const FORBIDDEN: Array<[string, string, Record<string, string>?]> = [
    ["POST", "/v1.43/build"],
    ["POST", "/v1.43/commit"],
    ["POST", "/v1.43/auth"],
    ["POST", "/v1.43/session"],
    ["GET", "/v1.43/info"],
    ["GET", "/v1.43/version"],
    // Events only with the one fixed filter: never unfiltered, never another filter, never extra parameters.
    ["GET", "/v1.43/events"],
    ["GET", "/v1.43/events?"],
    ["GET", `/v1.43/events?filters=${encodeURIComponent(JSON.stringify({ type: ["container"] }))}`],
    ["GET", `/v1.43/events?filters=${encodeURIComponent(JSON.stringify({ type: ["container"], event: ["exec_create"], label: ["dockify.managed=true"] }))}`],
    ["GET", `/v1.43${START_EVENTS_PATH}&since=0`],
    ["GET", `/v1.43/events?since=0&${START_EVENTS_PATH.split("?")[1]}`],
    ["POST", `/v1.43${START_EVENTS_PATH}`],
    ["GET", "/v1.43/system/df"],
    // The disk usage read is for images and volumes only: container sizes walk every writable layer.
    ["GET", "/v1.43/system/df?"],
    ["GET", "/v1.43/system/df?type=container"],
    ["GET", "/v1.43/system/df?type=build-cache"],
    ["GET", "/v1.43/system/df?type=image&type=container"],
    ["GET", "/v1.43/system/df?type=container&type=image"],
    ["GET", "/v1.43/system/df?type=image&type=volume&type=container"],
    ["GET", "/v1.43/system/df?type=image&verbose=1"],
    ["POST", "/v1.43/system/df?type=image"],
    ["GET", "/v1.43/system/df/x?type=image"],
    ["GET", "/v1.43/system/info?type=image"],
    ["GET", "/v1.43/_ping"],
    ["HEAD", "/v1.43/_ping"],
    ["GET", "/v1.43/containers/dk-abc/archive"],
    ["PUT", "/v1.43/containers/dk-abc/archive"],
    ["HEAD", "/v1.43/containers/dk-abc/archive"],
    ["GET", "/v1.43/containers/dk-abc/export"],
    ["GET", "/v1.43/containers/dk-abc/changes"],
    ["GET", "/v1.43/containers/dk-abc/top"],
    ["POST", "/v1.43/containers/dk-abc/update"],
    ["POST", "/v1.43/containers/dk-abc/pause"],
    ["POST", "/v1.43/containers/dk-abc/resize"],
    ["POST", "/v1.43/containers/dk-abc/restart"],
    ["POST", "/v1.43/containers/prune"],
    ["POST", "/v1.43/images/prune"],
    ["POST", "/v1.43/images/nginx/push"],
    ["POST", "/v1.43/images/nginx/tag"],
    // A pull is exactly fromImage and an optional tag, with no Content-Type: Docker reads a form body
    // too, and its fields win over the query, so fromSrc would import from any URL.
    ["POST", "/v1.43/images/create"],
    ["POST", "/v1.43/images/create?fromSrc=http%3A%2F%2Fx%2Fy.tar"],
    ["POST", "/v1.43/images/create?fromImage=x&fromSrc=http%3A%2F%2Fx%2Fy.tar"],
    ["POST", "/v1.43/images/create?fromImage=x;fromSrc=-"],
    ["POST", "/v1.43/images/create?fromImage=x%26fromSrc%3D-"],
    ["POST", "/v1.43/images/create?fromImage=x&repo=y"],
    ["POST", "/v1.43/images/create?fromImage=x&platform=y"],
    ["POST", "/v1.43/images/create?fromImage=x", { "content-type": "application/x-www-form-urlencoded" }],
    // A delete names an id Docker gave, or a build's own tag: never the install's images.
    ["DELETE", "/v1.43/images/traefik%3Av3.5.3"],
    ["DELETE", "/v1.43/images/nginx"],
    ["DELETE", "/v1.43/images/..%2f..%2fcontainers%2fdockify-worker"],
    ["DELETE", "/v1.43/images/sha256%3Aabc"],
    ["GET", "/v1.43/images/nginx/history"],
    ["GET", "/v1.43/images/nginx/get"],
    ["GET", "/v1.43/images/get"],
    ["GET", "/v1.43/images/search"],
    ["POST", "/v1.43/volumes/prune"],
    ["GET", "/v1.43/volumes"],
    // the control-plane database volume must never be reachable for deletion
    ["DELETE", "/v1.43/volumes/dockify-db"],
    ["DELETE", "/v1.43/volumes/dockify_dockify-db"],
    ["DELETE", "/v1.43/volumes/postgres-data"],
    // exec/attach must be reachable only on the data module's own managed names, never the control
    // containers or an arbitrary daemon id, so a worker compromise cannot read the master key
    ["POST", "/v1.43/containers/dockify-api-1/exec"],
    ["POST", "/v1.43/containers/postgres/exec"],
    ["POST", "/v1.43/containers/dockify-web-1/exec"],
    ["POST", "/v1.43/containers/0123456789abcdef0123456789abcdef/exec"],
    ["POST", "/v1.43/containers/dockify-api-1/attach"],
    ["POST", "/v1.43/containers/web/attach"],
    // An encoded slash: Docker decodes dk-x%2Fapi to dk-x/api, the legacy link alias "api" of a
    // container named dk-x, which can point at the api container itself.
    ["POST", "/v1.43/containers/dk-x%2Fapi/exec"],
    ["POST", "/v1.43/containers/dk-x%2fapi/attach"],
    ["POST", "/v1.43/containers/dockify-rt-x%2Fdb/exec"],
    // Rename only from one dk- name to another. Renaming a control container (by name or daemon id)
    // into the dk- names would open exec and attach on it; renaming a dk- container out of them, or
    // into a dockify-rt/bk/rs- name, has no use.
    ["POST", "/v1.43/containers/dockify-api-1/rename?name=dk-x"],
    ["POST", "/v1.43/containers/postgres/rename?name=dk-x"],
    ["POST", `/v1.43/containers/${HEX_ID}/rename?name=dk-x`],
    ["POST", "/v1.43/containers/0123456789ab/rename?name=dk-x"],
    ["POST", "/containers/dockify-api-1/rename?name=dk-x"],
    ["POST", "/v1.43/containers/dk-x/rename?name=dockify-api-1"],
    ["POST", "/v1.43/containers/dk-x/rename?name=dockify-rt-x"],
    ["POST", "/v1.43/containers/dk-x/rename?name="],
    ["POST", "/v1.43/containers/dk-x/rename"],
    ["POST", "/v1.43/containers/dk-x%2Fapi/rename?name=dk-y"],
    // Docker reads the first name= copy, while an ACL on url_param(name) passes when any copy matches.
    ["POST", "/v1.43/containers/dk-x/rename?name=dockify-api-1&name=dk-y"],
    ["POST", "/v1.43/containers/dk-x/rename?name=dk-y&name=dockify-api-1"],
    ["POST", "/v1.43/containers/dk-x/rename?name=dk-y;name=dockify-api-1"],
    // Docker reads a form body too, and its fields win over the query string.
    ["POST", "/v1.43/containers/dk-x/rename?name=dk-y", { "content-type": "application/x-www-form-urlencoded" }],
    ["POST", "/v1.43/containers/dk-x/rename?name=dk-y", { "Content-Type": "Application/X-WWW-Form-Urlencoded; charset=utf-8" }],
    ["GET", "/v1.43/networks"],
    ["GET", `/v1.43/networks?filters=${encodeURIComponent(JSON.stringify({ name: ["dockify-"] }))}`],
    ["GET", `/v1.43/networks?filters=${encodeURIComponent(JSON.stringify({ name: ["dockify-env-"] }))}&x=1`],
    // Only an environment's own network, in full: never a control network or the deploy network.
    ["DELETE", "/v1.43/networks/dockify-env-abc"],
    ["DELETE", "/v1.43/networks/dockify-deploy"],
    ["DELETE", "/v1.43/networks/dockify_control"],
    ["DELETE", "/v1.43/networks/dockify_socket"],
    ["DELETE", "/v1.43/networks/dockify-helpers"],
    ["DELETE", "/v1.43/networks/dockify-pv-forks"],
    ["DELETE", `/v1.43/networks/${HEX_ID}`],
    // An anonymous volume's name is exactly 64 hex characters.
    ["DELETE", `/v1.43/volumes/${HEX_ID.slice(0, 63)}`],
    ["DELETE", `/v1.43/volumes/${HEX_ID}0`],
    ["POST", "/v1.43/networks/prune"],
    ["POST", "/v1.43/exec/0123456789abcdef/resize"],
    // the terminal's rule is the full id and exactly two numbers: no other id form, order or extra field
    ["POST", `/v1.43/exec/${HEX_ID}/resize`],
    ["POST", `/v1.43/exec/${HEX_ID}/resize?w=120&h=40`],
    ["POST", `/v1.43/exec/${HEX_ID}/resize?h=40&w=120&x=1`],
    ["POST", `/v1.43/exec/dk-abc/resize?h=40&w=120`],
    ["POST", `/v1.43/containers/${HEX_ID}/resize?h=40&w=120`],
    ["POST", "/v1.43/swarm/init"],
    ["GET", "/v1.43/services"],
    ["GET", "/v1.43/secrets"],
    ["GET", "/v1.43/configs"],
    ["GET", "/v1.43/plugins"],
    ["POST", "/v1.43/plugins/pull"],
    ["GET", "/v1.43/nodes"],
    ["GET", "/v1.43/tasks"],
    ["GET", "/v1.43/distribution/nginx/json"],
    // a path that tries to smuggle a second segment past the one-segment rules
    ["GET", "/v1.43/containers/dk-abc/json/../archive"],
    ["DELETE", "/v1.43/containers/dk-abc/../../images/nginx"],
    ["GET", "/v1.43/containers/a/b/json"],
    ["POST", "/v1.43/containers/create/../prune"],
    ["POST", "/v1.43/containers/createx"],
    ["POST", "/containers/dk-abc/exec/"],
    ["CONNECT", "/v1.43/containers/json"],
    ["OPTIONS", "/v1.43/containers/json"],
  ];

  return { APP_ID, ENV_ID, LIVE, PARKED, HEX_ID, USED, AGENT_ONLY, FORBIDDEN };
}
