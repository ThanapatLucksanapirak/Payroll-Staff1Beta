// A restore holds the whole backup in memory several times over (the request
// body, the parsed JSON, the checked copy, the pre-restore backup, the import).
// On a small server a big backup can use up the memory and the operating
// system then stops the app with no error. So before reading a restore, check
// there is room for it, and refuse with a clear message if there isn't.
import fs from "node:fs";
import os from "node:os";
import v8 from "node:v8";

/**
 * About how much memory a restore needs, as a multiple of the backup's JSON
 * size (measured: an 80 MB file peaked about 940 MB above idle), and how much
 * of that is JavaScript heap. `available` overrides the measurement (tests).
 */
export const restoreMemory = { factor: 12, heapFactor: 6, available: null as null | { system: number; heap: number } };

function readNumber(file: string): number | null {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (!/^\d+$/.test(t)) return null; // "max" = no limit
    return Number(t);
  } catch { return null; }
}

/** Memory the system can still give this process (bytes), and V8 heap headroom. */
export function availableMemory(): { system: number; heap: number } {
  if (restoreMemory.available) return restoreMemory.available;
  let system = Number.POSITIVE_INFINITY;
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (m) system = Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  if (!Number.isFinite(system)) system = Math.max(0, os.freemem());
  // A container's own limit (cgroup v2, then v1)
  const max = readNumber("/sys/fs/cgroup/memory.max") ?? readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cur = readNumber("/sys/fs/cgroup/memory.current") ?? readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (max != null && cur != null && max < 1e15) system = Math.min(system, Math.max(0, max - cur));
  const h = v8.getHeapStatistics();
  return { system, heap: Math.max(0, h.heap_size_limit - h.used_heap_size) };
}

const mb = (n: number) => Math.max(1, Math.round(n / 1048576));

/** Null when a backup of `bytes` (JSON) fits in memory now, or the message to refuse it with. */
export function restoreMemoryProblem(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const { system, heap } = availableMemory();
  const needSystem = bytes * restoreMemory.factor;
  const needHeap = bytes * restoreMemory.heapFactor;
  if (needSystem <= system && needHeap <= heap) return null;
  const short = needSystem > system ? { need: needSystem, have: system } : { need: needHeap, have: heap };
  console.warn(`[restore] refused a ${mb(bytes)} MB backup: needs about ${mb(short.need)} MB of memory, ${mb(short.have)} MB free`);
  return `This backup (${mb(bytes)} MB) is too big to restore on this server right now: it needs about ${mb(short.need)} MB of free memory and only ${mb(short.have)} MB is free. Nothing was restored. Restart the app and try again, or restore it on a server with more memory.`;
}

/** The uncompressed size of a .gz file, from its trailer (exact below 4 GB). */
export function gzipSize(file: string): number {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size < 18) return 0;
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, size - 4);
    return buf.readUInt32LE(0);
  } catch { return 0; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
