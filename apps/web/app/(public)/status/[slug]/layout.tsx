import { headers } from "next/headers";
import { NONCE_HEADER } from "@/lib/security-headers";

/* The theme follows the visitor's system and ignores one stored by the console: a visitor never picked it. */
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
