/*
 * The catalog: one reviewed file per template, read from each app's own docs and image README (the
 * docs field names the page), and listed here. Written for Dockify, not copied from any other
 * project's catalog. A new template needs its own file, a line here and a pass of templates.test.ts.
 */
import type { Template } from "../format.ts";
import { uptimeKuma } from "./uptime-kuma.ts";
import { seaweedfs } from "./seaweedfs.ts";
import { memos } from "./memos.ts";
import { miniflux } from "./miniflux.ts";
import { gotify } from "./gotify.ts";
import { ntfy } from "./ntfy.ts";

export const CATALOG: Template[] = [uptimeKuma, seaweedfs, memos, miniflux, gotify, ntfy];
