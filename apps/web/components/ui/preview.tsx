"use client";

import { createContext, useContext } from "react";

/*
 * Preview mode for every page: true while the page runs on the preview fixture, where actions
 * toast what they would do and send nothing. One context, so DeployRow's Redeploy (which reads it)
 * knows the mode on every page, not only on Overview.
 *
 *   <PreviewProvider preview={result.source === "preview"}>...page...</PreviewProvider>
 *   const preview = usePreview();
 */
const PreviewContext = createContext(false);

/** Wraps a page so everything under it, DeployRow included, knows whether this is the preview. */
export function PreviewProvider({ preview, children }: { preview: boolean; children: React.ReactNode }) {
  return <PreviewContext.Provider value={preview}>{children}</PreviewContext.Provider>;
}

/** True on the preview fixture. */
export function usePreview() {
  return useContext(PreviewContext);
}
