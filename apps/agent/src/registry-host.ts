/**
 * The registry rule the gate applies to a pull. It lives in @dockify/contracts, where the api's check
 * at save time reads the same copy, and that file says what it refuses and what it cannot.
 */
export { CONTROL_SUBNETS, refusedHost, refusedPull, registryHost } from "@dockify/contracts";
