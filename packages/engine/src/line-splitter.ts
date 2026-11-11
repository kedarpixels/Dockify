/** One line is at most this many characters; a longer one is cut and flushed. */
export const MAX_LINE = 16 * 1024;

/**
 * Bounded buffering: a partial line is flushed once it reaches MAX_LINE. CR counts as a line break, so a
 * carriage-return progress bar becomes separate lines, not one huge one.
 */
export class LineSplitter {
  private partial = "";
  private readonly emit: (text: string) => void;
  constructor(emit: (text: string) => void) {
    this.emit = emit;
  }
  push(chunk: string): void {
    let s = this.partial + chunk;
    for (;;) {
      const i = s.search(/\r\n|\n|\r/);
      if (i < 0) break;
      this.emit(s.slice(0, i));
      s = s.slice(i + (s.startsWith("\r\n", i) ? 2 : 1));
    }
    while (s.length >= MAX_LINE) {
      this.emit(s.slice(0, MAX_LINE));
      s = s.slice(MAX_LINE);
    }
    this.partial = s;
  }
  end(): void {
    if (this.partial) this.emit(this.partial);
    this.partial = "";
  }
}
