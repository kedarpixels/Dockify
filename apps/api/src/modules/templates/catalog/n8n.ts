import type { Template } from "../format.ts";

export const n8n: Template = {
  id: "n8n",
  name: "n8n",
  summary: "Workflow automation with a visual editor.",
  category: "Automation",
  icon: "n8n",
  license: "Sustainable Use License, not open source",
  homepage: "https://n8n.io",
  docs: "https://docs.n8n.io/hosting/installation/docker/",
  firstRun: "It asks you to create the owner account. Do that before you share the address. Its license limits commercial use.",
  primary: "n8n",
  memoryMb: {"n8n": 512},
  secrets: {"N8N_ENCRYPTION_KEY": "hex32"},
  inputs: [],
  compose: `services:
  n8n:
    image: n8nio/n8n:2.46.6
    ports: ["5678"]
    volumes: ["data:/home/node/.n8n"]
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: "{{ref.db.host}}"
      DB_POSTGRESDB_PORT: "{{ref.db.port}}"
      DB_POSTGRESDB_DATABASE: "{{ref.db.database}}"
      DB_POSTGRESDB_USER: "{{ref.db.user}}"
      DB_POSTGRESDB_PASSWORD: "{{ref.db.password}}"
      N8N_ENCRYPTION_KEY: "{{secret.N8N_ENCRYPTION_KEY}}"
      N8N_HOST: "{{hostname}}"
      N8N_PROTOCOL: https
      N8N_PROXY_HOPS: "1"
      N8N_EDITOR_BASE_URL: "{{url}}"
      WEBHOOK_URL: "{{url}}"
  db:
    image: postgres:17
volumes:
  data:
`,
};
