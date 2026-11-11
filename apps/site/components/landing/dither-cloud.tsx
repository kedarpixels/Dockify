"use client";

import { useEffect, useRef } from "react";

/* Ordered (Bayer) dithering over smooth value noise, in two theme tones (--cloud, --cloud-core). Redraws at a
   low rate, pauses off screen and holds still under reduced motion. */

const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
].map((row) => row.map((v) => (v + 0.5) / 64));

const FPS = 8;
const DRIFT = { x: 0.055, y: -0.03 };

function hash(x: number, y: number, seed: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

type Corner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export function DitherCloud({
  cols,
  rows,
  cell = 8,
  corner,
  seed = 3,
  className,
}: {
  cols: number;
  rows: number;
  cell?: number;
  corner: Corner;
  seed?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = cols * cell * dpr;
    canvas.height = rows * cell * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const fromRight = corner.endsWith("right");
    const fromBottom = corner.startsWith("bottom");
    const base = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const dx = (fromRight ? cols - 1 - c : c) / cols;
        const dy = (fromBottom ? rows - 1 - r : r) / rows;
        base[r * cols + c] = Math.hypot(dx, dy);
      }

    const read = () => {
      const css = getComputedStyle(canvas);
      return { cloud: css.getPropertyValue("--cloud").trim(), core: css.getPropertyValue("--cloud-core").trim() };
    };
    let colors = read();
    const level = new Float32Array(cols * rows);

    const draw = (t: number) => {
      const ox = t * DRIFT.x;
      const oy = t * DRIFT.y;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const wobble = (noise(c / 7 + ox, r / 7 + oy, seed) - 0.5) * 0.34;
          level[r * cols + c] = 1 - smoothstep(0.38, 0.98, base[r * cols + c]! + wobble);
        }
      ctx.clearRect(0, 0, cols * cell, rows * cell);
      for (const core of [false, true]) {
        ctx.fillStyle = core ? colors.core : colors.cloud;
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++) {
            const density = level[r * cols + c]!;
            if (BAYER[r % 8]![c % 8]! < density && density > 0.82 === core) ctx.fillRect(c * cell, r * cell, cell, cell);
          }
      }
    };

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let raf = 0;
    let last = -Infinity;
    let visible = true;
    const loop = (now: number) => {
      if (!visible) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(loop);
      if (now - last < 1000 / FPS) return;
      last = now;
      draw((now - start) / 1000);
    };

    draw(0);
    canvas.dataset.ready = "true";
    const view = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible && !raf && !still) raf = requestAnimationFrame(loop);
    });
    const theme = new MutationObserver(() => {
      colors = read();
      draw(still ? 0 : (performance.now() - start) / 1000);
    });
    view.observe(canvas);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    if (!still) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      view.disconnect();
      theme.disconnect();
    };
  }, [cols, rows, cell, corner, seed]);

  return <canvas ref={ref} aria-hidden="true" className={className} style={{ width: cols * cell, height: rows * cell }} />;
}
