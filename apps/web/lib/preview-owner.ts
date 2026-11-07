import "server-only";
import type { ActorRef } from "./types";

/* The preview's people. Only the owner has a picture; the rest of the team keeps the default glyph. */
export const PREVIEW_OWNER_AVATAR = "/preview/sam.svg";
export const PREVIEW_OWNER_GITHUB = "sam";
export const PREVIEW_OWNER: ActorRef = { name: "Sam", avatarUrl: PREVIEW_OWNER_AVATAR, kind: "user" };
export const PREVIEW_LENA: ActorRef = { name: "Lena Hart", avatarUrl: null, kind: "user" };
