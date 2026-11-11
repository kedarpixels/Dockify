"use client";

import { createContext, useContext } from "react";

/* True on the preview fixture, where actions toast what they would do and send nothing. */
const PreviewContext = createContext(false);

export function PreviewProvider({ preview, children }: { preview: boolean; children: React.ReactNode }) {
  return <PreviewContext.Provider value={preview}>{children}</PreviewContext.Provider>;
}

export function usePreview() {
  return useContext(PreviewContext);
}
