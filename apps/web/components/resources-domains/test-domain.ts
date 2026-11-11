"use client";

import { useEffect, useState } from "react";
import { callJson } from "@/lib/client-api";
import type { TestDomainOffer } from "@/lib/pages/resources-domains";

/** Null until it answers, or for anyone who may not ask. Never offered in tunnel mode or without a public IPv4 address. */
export function useTestDomainOffer(): TestDomainOffer | null {
  const [offer, setOffer] = useState<TestDomainOffer | null>(null);
  useEffect(() => {
    let on = true;
    void callJson<TestDomainOffer>("/api/domains/test").then((r) => {
      if (on && r.ok) setOffer(r.data);
    });
    return () => {
      on = false;
    };
  }, []);
  return offer;
}
