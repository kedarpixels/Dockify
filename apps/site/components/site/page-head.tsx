export function PageHead({ eyebrow, title, lead }: { eyebrow?: string; title: string; lead?: string }) {
  return (
    <header className="phead">
      {eyebrow ? <p className="phead-eyebrow">{eyebrow}</p> : null}
      <h1 className="phead-title">{title}</h1>
      {lead ? <p className="phead-lead">{lead}</p> : null}
    </header>
  );
}

