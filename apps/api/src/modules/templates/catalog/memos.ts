import type { Template } from "../format.ts";

export const memos: Template = {
  id: "memos",
  name: "Memos",
  summary: "Quick notes, in a timeline of your own.",
  category: "Collaboration",
  icon: "",
  license: "MIT",
  homepage: "https://usememos.com",
  docs: "https://usememos.com/docs/installation/docker",
  firstRun: "It asks you to create the first account. Do that before you share the address. Its volume has no backup until you turn on a schedule on its Backups tab.",
  primary: "memos",
  memoryMb: {"memos": 128},
  secrets: {},
  inputs: [],
  compose: `services:
  memos:
    image: neosmemo/memos:26.11.0
    ports: ["5230"]
    volumes: ["data:/var/opt/memos"]
volumes:
  data:
`,
};
