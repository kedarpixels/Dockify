import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";

type Action = { href: string; label: string; icon?: IconName; external?: boolean };

function Go({ a, primary }: { a: Action; primary?: boolean }) {
  const inner = (
    <>
      {primary && a.icon ? <Icon name={a.icon} /> : null}
      {a.label}
    </>
  );
  const cls = primary ? "btn btn-primary" : "btn";
  return a.external ? (
    <a className={cls} href={a.href} target="_blank" rel="noreferrer noopener">
      {inner}
    </a>
  ) : (
    <Link className={cls} href={a.href}>
      {inner}
    </Link>
  );
}

export function Closer({ title, primary, secondary }: { title: string; primary: Action; secondary?: Action }) {
  return (
    <section className="pg-closer">
      <h2 className="pg-closer-h">{title}</h2>
      <div className="pg-closer-ctas">
        <Go a={primary} primary />
        {secondary ? <Go a={secondary} /> : null}
      </div>
    </section>
  );
}
