import type { Template } from "../format.ts";

export const seaweedfs: Template = {
  id: "seaweedfs",
  name: "SeaweedFS",
  summary: "S3 compatible object storage, on this server.",
  category: "Storage",
  icon: "",
  license: "Apache-2.0",
  homepage: "https://github.com/seaweedfs/seaweedfs",
  docs: "https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini",
  firstRun: "There is no login page. Its address is the S3 endpoint, its keys are AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in its variables, and it starts with one bucket, main. Its volume has no backup until you turn on a schedule on its Backups tab.",
  primary: "seaweedfs",
  memoryMb: {"seaweedfs": 512},
  secrets: {"ACCESS_KEY": "hex16", "SECRET_KEY": "hex32"},
  inputs: [],
  compose: `services:
  seaweedfs:
    image: chrislusf/seaweedfs:4.52
    ports: ["8333"]
    volumes: ["data:/data"]
    environment:
      AWS_ACCESS_KEY_ID: "{{secret.ACCESS_KEY}}"
      AWS_SECRET_ACCESS_KEY: "{{secret.SECRET_KEY}}"
      S3_BUCKET: main
volumes:
  data:
`,
};
