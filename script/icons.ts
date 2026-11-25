// Draws the app icons (the Logo from client/src/components/Logo.tsx) as PNGs
// for the installable app: `npx tsx script/icons.ts`. The output is committed
// in client/public/icons, so a normal build needs nothing extra.
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const OUT = path.resolve(import.meta.dirname, "..", "client", "public", "icons");

// ── PNG writer ───────────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf: Buffer) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ── The logo, in its 32×32 design units ──────────────────────────────────────
const TOP = [0x3b, 0x9b, 0xff], BOTTOM = [0x00, 0x60, 0xd6];
const LINES: [number, number, number, number][] = [[9.5, 11, 22.5, 11], [9.5, 16, 22.5, 16], [9.5, 21, 17, 21]];
const STROKE = 2.4 / 2;
const DOT = { x: 22.5, y: 21, r: 2.4, alpha: 0.75 };

function inRoundRect(x: number, y: number, r: number) {
  const cx = Math.min(Math.max(x, r), 32 - r), cy = Math.min(Math.max(y, r), 32 - r);
  return x >= 0 && y >= 0 && x <= 32 && y <= 32 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function segDist(px: number, py: number, [x1, y1, x2, y2]: [number, number, number, number]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * kind "any": rounded square on transparent; "full": full-bleed square (iOS
 * rounds it); "maskable": full bleed with the glyph inside the safe zone.
 */
function render(size: number, kind: "any" | "full" | "maskable"): Uint8Array {
  const S = 4; // supersampling
  const glyphScale = kind === "maskable" ? 0.72 : kind === "full" ? 0.9 : 1;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const x = ((px + (sx + 0.5) / S) / size) * 32, y = ((py + (sy + 0.5) / S) / size) * 32;
      if (kind === "any" && !inRoundRect(x, y, 8.5)) continue;
      const t = y / 32;
      let cr = TOP[0] + (BOTTOM[0] - TOP[0]) * t, cg = TOP[1] + (BOTTOM[1] - TOP[1]) * t, cb = TOP[2] + (BOTTOM[2] - TOP[2]) * t;
      const gx = 16 + (x - 16) / glyphScale, gy = 16 + (y - 16) / glyphScale;
      let white = 0;
      if (LINES.some((l) => segDist(gx, gy, l) <= STROKE)) white = 1;
      else if (Math.hypot(gx - DOT.x, gy - DOT.y) <= DOT.r) white = DOT.alpha;
      cr += (255 - cr) * white; cg += (255 - cg) * white; cb += (255 - cb) * white;
      r += cr; g += cg; b += cb; a += 1;
    }
    const n = S * S, i = (py * size + px) * 4;
    if (a) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
    out[i + 3] = Math.round((a / n) * 255);
  }
  return out;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b9bff"/><stop offset="1" stop-color="#0060d6"/></linearGradient></defs>
  <rect width="32" height="32" rx="8.5" fill="url(#g)"/>
  <path d="M9.5 11h13M9.5 16h13M9.5 21h7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="22.5" cy="21" r="2.4" fill="#fff" fill-opacity="0.75"/>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
const files: [string, number, "any" | "full" | "maskable"][] = [
  ["icon-192.png", 192, "any"],
  ["icon-512.png", 512, "any"],
  ["icon-maskable-512.png", 512, "maskable"],
  ["apple-touch-icon.png", 180, "full"],
];
for (const [name, size, kind] of files) {
  fs.writeFileSync(path.join(OUT, name), png(size, render(size, kind)));
  console.log(`wrote ${name}`);
}
fs.writeFileSync(path.join(OUT, "icon.svg"), SVG);
console.log("wrote icon.svg");
