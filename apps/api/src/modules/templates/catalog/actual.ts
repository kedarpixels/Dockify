import type { Template } from "../format.ts";

export const actual: Template = {
  id: "actual",
  name: "Actual Budget",
  summary: "Personal budgeting, private by default.",
  category: "Business",
  icon: "actualbudget",
  license: "MIT",
  homepage: "https://actualbudget.org",
  docs: "https://actualbudget.org/docs/install/docker",
  firstRun: "The first visitor sets the server password. Do that at once. Dockify does not back up its volume.",
  primary: "actual",
  memoryMb: {"actual": 256},
  secrets: {},
  inputs: [],
  compose: `services:
  actual:
    image: actualbudget/actual-server:26.11.0
    ports: ["5006"]
    volumes: ["data:/data"]
volumes:
  data:
`,
};
