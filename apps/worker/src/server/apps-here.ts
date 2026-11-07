/**
 * "On this server", as a where fragment. Every pass that compares rows with what one server's Docker,
 * route folder or disk holds reads its rows through this: an app on another server would otherwise
 * read as missing here, its images as unreferenced and its routes as orphans. Deployment and job rows
 * carry the same column.
 */
export const appsHere = (serverId: string): { serverId: string } => ({ serverId });
