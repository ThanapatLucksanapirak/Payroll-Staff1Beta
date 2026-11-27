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
