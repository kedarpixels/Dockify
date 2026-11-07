import type { Template } from "../format.ts";

export const pgadmin: Template = {
  id: "pgadmin",
  name: "pgAdmin",
  summary: "A web admin for Postgres.",
  category: "Developer tools",
  icon: "",
  license: "PostgreSQL",
  homepage: "https://www.pgadmin.org",
  docs: "https://www.pgadmin.org/docs/pgadmin4/latest/container_deployment.html",
  firstRun: "Sign in with the email you typed and PGADMIN_DEFAULT_PASSWORD, which you can reveal on its Variables tab. It is a public login to a tool that can reach your databases, so remove it when you are done.",
  primary: "pgadmin",
  memoryMb: {"pgadmin": 512},
  secrets: {"ADMIN_PASSWORD": "b64url24"},
  inputs: [{"key": "ADMIN_EMAIL", "label": "Admin email", "hint": "The first account signs in with this.", "type": "email"}],
  compose: `services:
  pgadmin:
    image: dpage/pgadmin4:9.19.0
    ports: ["8080"]
    volumes: ["data:/var/lib/pgadmin"]
    environment:
      PGADMIN_DEFAULT_EMAIL: "{{input.ADMIN_EMAIL}}"
      PGADMIN_DEFAULT_PASSWORD: "{{secret.ADMIN_PASSWORD}}"
      PGADMIN_LISTEN_PORT: "8080"
      PGADMIN_DISABLE_POSTFIX: "true"
volumes:
  data:
`,
};
