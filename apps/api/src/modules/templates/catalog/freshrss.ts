import type { Template } from "../format.ts";

export const freshrss: Template = {
  id: "freshrss",
  name: "FreshRSS",
  summary: "A feed reader you host.",
  category: "Content",
  icon: "freshrss",
  license: "AGPL-3.0",
  homepage: "https://freshrss.org",
  docs: "https://github.com/FreshRSS/FreshRSS/blob/edge/Docker/README.md",
  firstRun: "Sign in as admin with the password inside FRESHRSS_USER, which you can reveal on its Variables tab. Dockify does not back up its volume.",
  primary: "freshrss",
  memoryMb: {"freshrss": 256},
  secrets: {"ADMIN_PASSWORD": "b64url24"},
  inputs: [],
  compose: `services:
  freshrss:
    image: freshrss/freshrss:1.30.4-alpine
    ports: ["80"]
    volumes: ["data:/var/www/FreshRSS/data", "extensions:/var/www/FreshRSS/extensions"]
    environment:
      CRON_MIN: "1,31"
      TZ: UTC
      FRESHRSS_INSTALL: "--base-url {{url}} --default-user admin --language en"
      FRESHRSS_USER: "--user admin --password {{secret.ADMIN_PASSWORD}} --language en"
volumes:
  data:
  extensions:
`,
};
