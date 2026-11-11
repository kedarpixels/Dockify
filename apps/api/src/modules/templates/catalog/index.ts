// One reviewed file per template, written from each app's own docs. A new template needs its own file, a line here and a pass of templates.test.ts.
import type { Template } from "../format.ts";
import { n8n } from "./n8n.ts";
import { uptimeKuma } from "./uptime-kuma.ts";
import { ghost } from "./ghost.ts";
import { wordpress } from "./wordpress.ts";
import { metabase } from "./metabase.ts";
import { gitea } from "./gitea.ts";
import { forgejo } from "./forgejo.ts";
import { vaultwarden } from "./vaultwarden.ts";
import { seaweedfs } from "./seaweedfs.ts";
import { nextcloud } from "./nextcloud.ts";
import { directus } from "./directus.ts";
import { grafana } from "./grafana.ts";
import { listmonk } from "./listmonk.ts";
import { mattermost } from "./mattermost.ts";
import { wikijs } from "./wikijs.ts";
import { memos } from "./memos.ts";
import { freshrss } from "./freshrss.ts";
import { miniflux } from "./miniflux.ts";
import { gotify } from "./gotify.ts";
import { ntfy } from "./ntfy.ts";
import { pgadmin } from "./pgadmin.ts";
import { actual } from "./actual.ts";
import { docmost } from "./docmost.ts";

export const CATALOG: Template[] = [n8n, uptimeKuma, ghost, wordpress, metabase, gitea, forgejo, vaultwarden, seaweedfs, nextcloud, directus, grafana, listmonk, mattermost, wikijs, memos, freshrss, miniflux, gotify, ntfy, pgadmin, actual, docmost];
