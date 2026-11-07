/**
 * A real dashboard screenshot in the visitor's theme: one image per theme, and CSS shows the one that
 * matches html.dark (landing.css), so the saved theme decides with no swap after hydration. Both are
 * lazy, and a hidden image never loads. Each comes at 1440 and 2880 pixels wide, picked by srcset.
 * Shots live in /public/shots as <name>-<theme>.webp (2880 by 1800) and <name>-<theme>-1440.webp.
 */
export function ShotPicture({ name, alt }: { name: string; alt: string }) {
  const sizes = "(min-width: 1264px) 1166px, calc(100vw - 32px)";
  return (
    <>
      {(["light", "dark"] as const).map((theme) => (
        <img
          key={theme}
          className={`ld-shot-img ld-shot-${theme}`}
          src={`/shots/${name}-${theme}-1440.webp`}
          srcSet={`/shots/${name}-${theme}-1440.webp 1440w, /shots/${name}-${theme}.webp 2880w`}
          sizes={sizes}
          alt={alt}
          width={1440}
          height={900}
          decoding="async"
          loading="lazy"
          draggable={false}
        />
      ))}
    </>
  );
}
