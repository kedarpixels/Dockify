import type { Template } from "../format.ts";

export const vaultwarden: Template = {
  id: "vaultwarden",
  name: "Vaultwarden",
  summary: "Bitwarden compatible password manager.",
  category: "Security",
  icon: "vaultwarden",
  license: "AGPL-3.0",
  homepage: "https://github.com/dani-garcia/vaultwarden",
  docs: "https://github.com/dani-garcia/vaultwarden/wiki/Using-the-PostgreSQL-Backend",
  firstRun: "Anyone can create a vault until you turn signups off. Create yours, then set SIGNUPS_ALLOWED to false in its variables. Its keys and attachments are on a volume Dockify does not back up.",
  primary: "vaultwarden",
  memoryMb: {"vaultwarden": 256},
  secrets: {},
  inputs: [],
  compose: `services:
  vaultwarden:
    image: vaultwarden/server:1.37.5-alpine
    ports: ["80"]
    volumes: ["data:/data"]
    environment:
      DOMAIN: "{{url}}"
      DATABASE_URL: "{{ref.db.url}}"
  db:
    image: postgres:17
volumes:
  data:
`,
};
