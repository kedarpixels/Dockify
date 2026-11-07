import type { Template } from "../format.ts";

export const docmost: Template = {
  id: "docmost",
  name: "Docmost",
  summary: "Team wiki and documents.",
  category: "Collaboration",
  icon: "",
  license: "AGPL-3.0 for its core",
  homepage: "https://docmost.com",
  docs: "https://docmost.com/docs/installation",
  firstRun: "The setup page creates the workspace and its owner. Do that before you share the address. Invites need email set up. Dockify does not back up its file volume.",
  primary: "docmost",
  memoryMb: {"docmost": 512},
  secrets: {"APP_SECRET": "hex32"},
  inputs: [],
  compose: `services:
  docmost:
    image: docmost/docmost:0.97.0
    ports: ["3000"]
    volumes: ["storage:/app/data/storage"]
    environment:
      APP_URL: "{{url}}"
      APP_SECRET: "{{secret.APP_SECRET}}"
      DATABASE_URL: "{{ref.db.url}}"
      REDIS_URL: "{{ref.cache.url}}"
  db:
    image: postgres:17
  cache:
    image: redis:8.2
volumes:
  storage:
`,
};
