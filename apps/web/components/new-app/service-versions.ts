// Newest first: the first is the default ("Latest"). An API test (projects/versions.test.ts) reads
// this file as text and fails when the API's list differs, so keep it to this one object of string arrays.
export const SERVICE_VERSIONS: Record<"postgres" | "redis", string[]> = {
  postgres: ["17", "16", "15"],
  redis: ["8.2", "7.4"],
};
