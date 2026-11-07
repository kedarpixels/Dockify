/* Theme toggle tick: one short mp3, loaded on first use and replayed from the start. */
let tick: HTMLAudioElement | null = null;

export function playClick() {
  tick ??= Object.assign(new Audio("/sounds/toggle.mp3"), { volume: 0.6 });
  tick.currentTime = 0;
  tick.play().catch(() => {
    /* autoplay blocked or no audio: stay silent */
  });
}
