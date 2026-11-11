/**
 * "On this server" as a where fragment. Every pass comparing rows with one server's Docker, routes or
 * disk reads through it, or another server's apps read as missing and their images and routes as orphans.
 */
export const appsHere = (serverId: string): { serverId: string } => ({ serverId });
