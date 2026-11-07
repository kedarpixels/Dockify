/* Two bars that cross into an X when open. */
export function Burger({ open }: { open: boolean }) {
  return (
    <span className="burger" data-open={open} aria-hidden="true">
      <span />
      <span />
    </span>
  );
}
