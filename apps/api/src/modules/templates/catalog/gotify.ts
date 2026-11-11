import type { Template } from "../format.ts";

export const gotify: Template = {
  id: "gotify",
  name: "Gotify",
  summary: "Send and receive push notifications.",
  category: "Monitoring",
  icon: "",
  license: "MIT",
  homepage: "https://gotify.net",
  docs: "https://gotify.net/docs/config",
  firstRun: "Sign in as admin with GOTIFY_DEFAULTUSER_PASS, which you can reveal on its Variables tab. Its volume has no backup until you turn on a schedule on its Backups tab.",
  primary: "gotify",
  memoryMb: {"gotify": 128},
  secrets: {"ADMIN_PASSWORD": "b64url24"},
  inputs: [],
  compose: `services:
  gotify:
    image: gotify/server:3.1.1
    ports: ["80"]
    volumes: ["data:/app/data"]
    environment:
      GOTIFY_DEFAULTUSER_NAME: admin
      GOTIFY_DEFAULTUSER_PASS: "{{secret.ADMIN_PASSWORD}}"
volumes:
  data:
`,
};
