import type { Template } from "../format.ts";

export const ghost: Template = {
  id: "ghost",
  name: "Ghost",
  summary: "Publishing platform for blogs and newsletters.",
  category: "Content",
  icon: "ghost",
  license: "MIT",
  homepage: "https://ghost.org",
  docs: "https://docs.ghost.org/install/docker",
  firstRun: "Open /ghost on the address and create the owner account at once. Invites and password resets need email set up in Ghost. Its MySQL container is not backed up by Dockify.",
  primary: "ghost",
  memoryMb: {"ghost": 512, "mysql": 768},
  secrets: {"DB_PASSWORD": "hex32", "DB_ROOT_PASSWORD": "hex32"},
  inputs: [],
  compose: `services:
  ghost:
    image: ghost:6.75-alpine
    ports: ["2368"]
    volumes: ["content:/var/lib/ghost/content"]
    environment:
      url: "{{url}}"
      database__client: mysql
      database__connection__host: "{{host.mysql}}"
      database__connection__user: ghost
      database__connection__password: "{{secret.DB_PASSWORD}}"
      database__connection__database: ghost
      security__staffDeviceVerification: "false"
  mysql:
    image: mysql:8.0.46
    volumes: ["mysql:/var/lib/mysql"]
    environment:
      MYSQL_ROOT_PASSWORD: "{{secret.DB_ROOT_PASSWORD}}"
      MYSQL_USER: ghost
      MYSQL_PASSWORD: "{{secret.DB_PASSWORD}}"
      MYSQL_DATABASE: ghost
volumes:
  content:
  mysql:
`,
};
