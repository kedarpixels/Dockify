import type { Template } from "../format.ts";

export const nextcloud: Template = {
  id: "nextcloud",
  name: "Nextcloud",
  summary: "Files, calendars and contacts.",
  category: "Files",
  icon: "nextcloud",
  license: "AGPL-3.0",
  homepage: "https://nextcloud.com",
  docs: "https://github.com/nextcloud/docker/blob/master/README.md",
  firstRun: "Sign in as admin with NEXTCLOUD_ADMIN_PASSWORD, which you can reveal on its Variables tab. The first start takes a few minutes. Your files are on a volume Dockify does not back up.",
  primary: "nextcloud",
  memoryMb: {"nextcloud": 1024},
  secrets: {"ADMIN_PASSWORD": "b64url24"},
  inputs: [],
  compose: `services:
  nextcloud:
    image: nextcloud:35.0-apache
    ports: ["80"]
    volumes: ["html:/var/www/html"]
    environment:
      POSTGRES_HOST: "{{ref.db.host}}"
      POSTGRES_DB: "{{ref.db.database}}"
      POSTGRES_USER: "{{ref.db.user}}"
      POSTGRES_PASSWORD: "{{ref.db.password}}"
      NEXTCLOUD_ADMIN_USER: admin
      NEXTCLOUD_ADMIN_PASSWORD: "{{secret.ADMIN_PASSWORD}}"
      NEXTCLOUD_TRUSTED_DOMAINS: "{{hostname}}"
      OVERWRITEPROTOCOL: https
      OVERWRITEHOST: "{{hostname}}"
      OVERWRITECLIURL: "{{url}}"
      REDIS_HOST: "{{ref.cache.host}}"
      REDIS_HOST_PORT: "{{ref.cache.port}}"
      REDIS_HOST_PASSWORD: "{{ref.cache.password}}"
  db:
    image: postgres:17
  cache:
    image: redis:8.2
volumes:
  html:
`,
};
