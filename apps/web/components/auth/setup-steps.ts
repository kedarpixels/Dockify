/* The steps of first-run setup. The bars and the count follow the road this install is on. */

export type SetupStep = "account" | "connect" | "verify" | "protect" | "domain";

/**
 * Email the installer already set up has no connect step. Otherwise the connect step comes after the
 * account, and setting email up later drops the code step behind it. An install still on the address
 * it started on (its sslip.io name) ends with the offer of its own domain: last, because moving signs
 * the admin out of this address.
 */
export function setupPlan(emailAtStart: boolean, skippedEmail: boolean, offerDomain = false): SetupStep[] {
  const steps: SetupStep[] = emailAtStart ? ["account", "verify", "protect"] : skippedEmail ? ["account", "connect", "protect"] : ["account", "connect", "verify", "protect"];
  return offerDomain ? [...steps, "domain"] : steps;
}

/** [current, total] for the step bars. */
export function stepCount(plan: SetupStep[], step: SetupStep): [number, number] {
  return [plan.indexOf(step) + 1, plan.length];
}

/** The step after this one, or "done" after the last. */
export function nextStep(plan: SetupStep[], step: SetupStep): SetupStep | "done" {
  return plan[plan.indexOf(step) + 1] ?? "done";
}

/** The last card's words: what was left off, and where to turn it on. */
export function doneLead(instance: string, mfa: boolean, emailOff: boolean): string {
  const name = instance || "Dockify";
  const factor = mfa
    ? `${name} is ready, and two-factor is on. If you ever lose your authenticator, you can turn it off from the server over SSH.`
    : `${name} is ready. Two-factor is off; turn it on any time in Settings.`;
  return emailOff ? `${factor} Email is off too; connect it in Settings, Integrations.` : factor;
}
