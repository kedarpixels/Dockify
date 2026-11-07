/** One line is at most this many characters; a longer one is cut and flushed. */
export const MAX_LINE = 16 * 1024;

/**
 * Turns a byte stream into lines without unbounded buffering: a partial line is flushed once it
 * reaches MAX_LINE (a carriage-return progress bar cannot grow a string forever). CR resets count
 * as line breaks so spinners become separate lines rather than one huge one.
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
