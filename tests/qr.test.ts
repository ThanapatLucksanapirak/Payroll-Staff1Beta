// The small QR encoder used for two-factor setup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alignmentPositions, encodeQr, formatBits, qrSvgPath, rsDivisor, rsRemainder, versionBits } from "../shared/qr";

test("Reed-Solomon matches the worked HELLO WORLD 1-M example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format, version and alignment tables match the standard", () => {
  const m = ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
  m.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, "0"), bits, `mask ${mask}`));
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(8), 0x085bc);
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(14), [6, 26, 46, 66]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(36), [6, 24, 50, 76, 102, 128, 154]);
});

/** Read a matrix back the way a scanner would: format bits, unmask, zig-zag, de-interleave, check error correction, decode bytes. */
function decode(qr: ReturnType<typeof encodeQr>): string {
  const { size, modules: mod } = qr;
  const ver = (size - 17) / 4;
  // Format bits (first copy) → mask
  const f: number[] = [];
  for (let i = 0; i <= 5; i++) f.push(+mod[i][8]);
  f.push(+mod[7][8], +mod[8][8], +mod[8][7]);
  for (let i = 9; i < 15; i++) f.push(+mod[8][14 - i]);
  const fmt = f.reduce((a, b, i) => a | (b << i), 0);
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => formatBits(k) === fmt);
  assert.notEqual(mask, undefined, "format bits are valid");
  // Second copy agrees
  let f2 = 0;
  for (let i = 0; i < 8; i++) f2 |= (+mod[8][size - 1 - i]) << i;
  for (let i = 8; i < 15; i++) f2 |= (+mod[size - 15 + i][8]) << i;
  assert.equal(f2, fmt);
  assert.equal(mod[size - 8][8], true, "dark module");
  // Function modules, built independently
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size); mark(0, 6, size, 1);
  const al = alignmentPositions(ver);
  for (const a of al) for (const b of al) {
    if ((a === 6 && b === 6) || (a === 6 && b === al[al.length - 1]) || (a === al[al.length - 1] && b === 6)) continue;
    mark(a - 2, b - 2, 5, 5);
  }
  if (ver >= 7) { mark(size - 11, 0, 3, 6); mark(0, size - 11, 6, 3); }
  // Finder pattern in the top-left corner
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    assert.equal(mod[y][x], d !== 2, `finder ${x},${y}`);
  }
  const masked = (x: number, y: number) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x]) bits.push((mod[y][x] !== masked(x, y)) ? 1 : 0);
    }
  }
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  assert.deepEqual(words.slice(0, qr.codewords!.length), qr.codewords, "codewords sit where a reader looks for them");
  // De-interleave (level M tables, versions 1-10)
  const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const BLK = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const total = qr.codewords!.length, nb = BLK[ver], ecc = ECC[ver];
  const shortLen = Math.floor(total / nb), numShort = nb - (total % nb);
  const lens = Array.from({ length: nb }, (_, i) => shortLen - ecc + (i < numShort ? 0 : 1));
  const blocks: number[][] = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...lens); i++) for (let b = 0; b < nb; b++) if (i < lens[b]) blocks[b].push(words[k++]);
  const eccBlocks: number[][] = lens.map(() => []);
  for (let i = 0; i < ecc; i++) for (let b = 0; b < nb; b++) eccBlocks[b].push(words[k++]);
  blocks.forEach((d, b) => assert.deepEqual(rsRemainder(d, rsDivisor(ecc)), eccBlocks[b], `block ${b} error correction`));
  const data = blocks.flat();
  const stream = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >>> i) & 1));
  const read = (pos: number, n: number) => stream.slice(pos, pos + n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(read(0, 4), 0b0100, "byte mode");
  const lenBits = ver < 10 ? 8 : 16;
  const len = read(4, lenBits);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(read(4 + lenBits + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(out));
}

test("encoded QR codes read back correctly for every mask and several sizes", () => {
  const texts = [
    "hi",
    "otpauth://totp/Payroll%20Admin%3Aalex?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Payroll%20Admin&algorithm=SHA1&digits=6&period=30",
    `otpauth://totp/${encodeURIComponent("Café Group Payroll:maria.long-username@example.com")}?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=${encodeURIComponent("Café Group Payroll")}&algorithm=SHA1&digits=6&period=30`,
  ];
  for (const t of texts) {
    const auto = encodeQr(t);
    assert.equal(decode(auto), t);
    assert.ok(auto.version <= 10);
    for (let mask = 0; mask < 8; mask++) assert.equal(decode(encodeQr(t, { version: auto.version, mask })), t, `mask ${mask}`);
  }
  assert.equal(encodeQr("hi").version, 1);
  assert.equal(encodeQr("x".repeat(150)).version, 8);
  assert.match(qrSvgPath(encodeQr("hi")), /^M4,4h1v1h-1z/);
  assert.throws(() => encodeQr("x".repeat(3000)));
});
