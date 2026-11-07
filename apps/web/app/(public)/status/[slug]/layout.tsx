import { headers } from "next/headers";
import { NONCE_HEADER } from "@/lib/security-headers";

/*
 * Public status pages sit outside the console: no shell, no sidebar, no session. One narrow ruled
 * column, the same frame as the signed-out pages. The page renders its blocks straight into it.
 *
 * The theme follows the visitor's system and ignores a theme stored by the console, since a
 * visitor never picked one. The script runs before the column paints and keeps listening, but
 * only acts while a status page is open.
 */
const followSystem = `try{var m=matchMedia("(prefers-color-scheme: dark)");var s=function(){if(location.pathname.indexOf("/status/")===0)document.documentElement.classList.toggle("dark",m.matches)};s();m.addEventListener("change",s)}catch(e){}`;

export default async function StatusLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: followSystem }} />
      <main className="page stp" id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
