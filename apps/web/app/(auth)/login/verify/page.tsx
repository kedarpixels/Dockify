import type { Metadata } from "next";
import { VerifyView } from "@/components/auth/verify-view";
import { safeNext } from "@/components/auth/util";

export const metadata: Metadata = { title: "Two-factor check" };

/** /login/verify: the authenticator code. The API holds the pending sign in in a cookie. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <VerifyView next={safeNext(next)} />;
}
