import type { Template } from "../format.ts";

export const directus: Template = {
  id: "directus",
  name: "Directus",
  summary: "Headless CMS and data platform.",
  category: "Content",
  icon: "directus",
  license: "MSCL-1.0-GPL, free for internal use only",
  homepage: "https://directus.io",
  docs: "https://directus.io/docs/self-hosting/deploying",
  firstRun: "Sign in with the email you typed and ADMIN_PASSWORD, which you can reveal on its Variables tab.",
  primary: "directus",
  memoryMb: {"directus": 512},
  secrets: {"SECRET": "hex32", "ADMIN_PASSWORD": "b64url24"},
  inputs: [{"key": "ADMIN_EMAIL", "label": "Admin email", "hint": "The first account signs in with this.", "type": "email"}],
  compose: `services:
  directus:
    image: directus/directus:12.6
    ports: ["8055"]
    volumes: ["uploads:/directus/uploads", "extensions:/directus/extensions"]
    environment:
      SECRET: "{{secret.SECRET}}"
      DB_CLIENT: pg
      DB_HOST: "{{ref.db.host}}"
      DB_PORT: "{{ref.db.port}}"
      DB_DATABASE: "{{ref.db.database}}"
      DB_USER: "{{ref.db.user}}"
      DB_PASSWORD: "{{ref.db.password}}"
      ADMIN_EMAIL: "{{input.ADMIN_EMAIL}}"
      ADMIN_PASSWORD: "{{secret.ADMIN_PASSWORD}}"
      PUBLIC_URL: "{{url}}"
  db:
    image: postgres:17
volumes:
  uploads:
  extensions:
`,
};
