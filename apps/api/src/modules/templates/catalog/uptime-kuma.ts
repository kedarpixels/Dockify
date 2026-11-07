import type { Template } from "../format.ts";

export const uptimeKuma: Template = {
  id: "uptime-kuma",
  name: "Uptime Kuma",
  summary: "Uptime monitoring with status pages.",
  category: "Monitoring",
  icon: "uptimekuma",
  license: "MIT",
  homepage: "https://uptime.kuma.pet",
  docs: "https://github.com/louislam/uptime-kuma/wiki/Environment-Variables",
  firstRun: "It asks you to create the admin account. Do that before you share the address, then turn on Trust Proxy under Settings, Reverse Proxy.",
  primary: "kuma",
  memoryMb: {"kuma": 256},
  secrets: {},
  inputs: [],
  compose: `services:
  kuma:
    image: louislam/uptime-kuma:2.5.9-rootless
    ports: ["3001"]
    volumes: ["data:/app/data"]
    environment:
      UPTIME_KUMA_DB_TYPE: sqlite
volumes:
  data:
`,
};
