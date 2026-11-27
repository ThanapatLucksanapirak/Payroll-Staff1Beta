// Stability run 3: a Supabase reply that stalls after its headers times out
// instead of hanging the request, and a cut-off or garbled reply is a database
// error, never an empty setting or a short list.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SupabaseStore, supabaseTimeout } from "../server/db/supabase";
import { StoreError } from "../server/db/types";

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

type Mode = "stall" | "drop" | "garbled" | "object" | "html500" | "ok";
async function withServer(mode: Mode, run: (store: SupabaseStore) => Promise<void>) {
  const server = http.createServer((req, res) => {
    req.resume();
    if (mode === "html500") { res.writeHead(502, { "Content-Type": "text/html" }); return res.end("<html>Bad gateway</html>"); }
    if (mode === "ok") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify([{ key: "k", value: "v" }])); }
    if (mode === "garbled") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("[{\"value\": \"v\"}garbage"); }
    if (mode === "object") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("{\"oops\":true}"); }
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
    res.write('[{"value": "');
    if (mode === "drop") setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const store = new SupabaseStore(`http://127.0.0.1:${port}`, "sb_secret_0123456789abcdefghij");
  const old = supabaseTimeout.ms;
  supabaseTimeout.ms = 300;
  try { await run(store); } finally { supabaseTimeout.ms = old; server.closeAllConnections(); server.close(); }
}

test("a reply that stalls after the headers times out instead of hanging", async () => {
  await withServer("stall", async (store) => {
    const t = Date.now();
    await assert.rejects(store.getSetting("k"), (e: any) => e instanceof StoreError && e.status === 503 && /took too long/.test(e.message));
    assert.ok(Date.now() - t < 3000, "gave up quickly");
    await assert.rejects(store.allSettings(), (e: any) => e instanceof StoreError && /took too long/.test(e.message));
  });
});

test("a cut-off reply is a database error, not a raw TypeError", async () => {
  await withServer("drop", async (store) => {
    await assert.rejects(store.getSetting("k"), (e: any) => e instanceof StoreError && e.status === 503 && /cut off/.test(e.message));
  });
});

test("a garbled or non-list 200 is an error, never an empty setting or a short list", async () => {
  for (const mode of ["garbled", "object"] as const) {
    await withServer(mode, async (store) => {
      await assert.rejects(store.getSetting("k"), (e: any) => e instanceof StoreError && e.status === 502 && /couldn't be read/.test(e.message), mode);
      await assert.rejects(store.allSettings(), (e: any) => e instanceof StoreError && /couldn't be read/.test(e.message), mode);
    });
  }
});

test("an HTML error page gives a clean database error", async () => {
  await withServer("html500", async (store) => {
    await assert.rejects(store.getSetting("k"), (e: any) => e instanceof StoreError && e.status === 503 && !/<html>/.test(e.message));
  });
});

test("a normal reply still works", async () => {
  await withServer("ok", async (store) => {
    assert.equal(await store.getSetting("k"), "v");
  });
});

test("a big restore is sent in batches, each with the longer import limit", async () => {
  const { IMPORT_BATCH } = await import("../server/db/supabase");
  const posts: { table: string; rows: number }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const table = url.pathname.split("/").pop()!;
      if (req.method === "POST") {
        posts.push({ table, rows: JSON.parse(Buffer.concat(chunks).toString()).length });
        // Slower than a normal request may take, well inside the import limit.
        return setTimeout(() => { res.writeHead(201); res.end(); }, 500);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const store = new SupabaseStore(`http://127.0.0.1:${port}`, "sb_secret_0123456789abcdefghij");
  const old = { ms: supabaseTimeout.ms, imp: IMPORT_BATCH.timeoutMs };
  supabaseTimeout.ms = 300;
  IMPORT_BATCH.timeoutMs = 3000;
  try {
    const punches = Array.from({ length: 4500 }, (_, i) => ({ id: `p${i}`, siteId: "main", employeeId: "e1", employeeName: "Ana", type: "in" as const, at: "2026-01-01T00:00:00.000Z", source: "kiosk" as const, deviceId: "d1", note: "", createdAt: "2026-01-01T00:00:00.000Z", editedAt: null, edits: [] }));
    await store.importAll({ settings: [{ key: "k", value: "v" }], timesheets: [], punches }, { replace: false });
    const punchPosts = posts.filter((p) => p.table === "punches").map((p) => p.rows);
    assert.deepEqual(punchPosts, [2000, 2000, 500]);
    assert.ok(punchPosts.every((n) => n <= IMPORT_BATCH.punches));
  } finally {
    supabaseTimeout.ms = old.ms;
    IMPORT_BATCH.timeoutMs = old.imp;
    server.closeAllConnections();
    server.close();
  }
});
