/*
 * The managed service versions New app offers, newest first: the first is the default ("Latest").
 * The API accepts exactly these (apps/api/src/modules/projects/app-source.ts, SERVICE_IMAGES), and
 * apps/api/src/modules/projects/versions.test.ts fails the moment the two lists differ. That test
 * reads this file as text, so keep it to this one object of quoted string arrays.
 */
export const SERVICE_VERSIONS: Record<"postgres" | "redis", string[]> = {
  postgres: ["17", "16", "15"],
  redis: ["8.2", "7.4"],
};
