/** A short, human message for an API status, so the UI never shows a raw "API answered 500". */
export function apiErrorMessage(status: number): string {
  if (status === 401) return "Sign in again";
  if (status === 403) return "You do not have access to this";
  if (status === 404) return "Not found";
  if (status === 409) return "That changed since you loaded it, reload and try again";
  if (status === 429) return "Too many requests, try again in a moment";
  if (status === 501) return "This is not available yet";
  if (status >= 500) return "The server had a problem, try again";
  return "That request could not be completed";
}
