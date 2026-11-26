// Gmail (Connect with Google): the app's sent emails get a label and leave the inbox.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-tidy-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SUPABASE_URL;

type Call = { url: string; method: string; body?: any; auth?: string };
const calls: Call[] = [];
let routes: (c: Call) => { status: number; body: any };

before(async () => {
  const { initDatabase } = await import("../server/db");
  await initDatabase();
  const g = await import("../server/emailGoogle");
  g.setTidyDelayForTests(0);
  g.setGoogleFetchForTests(async (url, init) => {
    const c: Call = { url, method: init.method, auth: init.headers.Authorization, body: init.body ? (init.headers["Content-Type"]?.includes("json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined };
    calls.push(c);
    const r = routes(c);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  });
});
after(async () => {
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = async () => ({ ...(await (await import("../server/email")).getEmailConfig()), provider: "google" as const, googleClientId: "cid", googleClientSecret: "sec", googleRefreshToken: "rt", googleAccount: "contact@shijiri.com", fromName: "Shijiri Payroll Service" });

test("labels the sent copy and takes it out of the inbox", async () => {
  calls.length = 0;
  routes = (c) => {
    if (c.url.includes("oauth2.googleapis.com/token")) return { status: 200, body: { access_token: "at" } };
    if (c.url.includes("/messages?q=")) return { status: 200, body: { messages: [{ id: "m1" }, { id: "m2" }] } };
    if (c.url.endsWith("/labels") && c.method === "GET") return { status: 200, body: { labels: [{ id: "INBOX", name: "INBOX" }] } };
    if (c.url.endsWith("/labels") && c.method === "POST") return { status: 200, body: { id: "Label_9", name: c.body.name } };
    if (c.url.endsWith("/messages/batchModify")) return { status: 204, body: {} };
    return { status: 404, body: {} };
  };
  const { tidySentGmail } = await import("../server/emailGoogle");
  const r = await tidySentGmail(await cfg(), "<abc@shijiri.com>");
  assert.deepEqual(r, { ok: true, tidied: 2 });
  assert.equal(calls[0].body.grant_type, "refresh_token");
  assert.ok(calls[1].url.includes(encodeURIComponent("rfc822msgid:abc@shijiri.com")));
  assert.equal(calls[1].auth, "Bearer at");
  const created = calls.find((c) => c.url.endsWith("/labels") && c.method === "POST")!;
  assert.equal(created.body.name, "Shijiri Payroll Service");
  const mod = calls.find((c) => c.url.endsWith("/batchModify"))!;
  assert.deepEqual(mod.body, { ids: ["m1", "m2"], addLabelIds: ["Label_9"], removeLabelIds: ["INBOX", "UNREAD"] });
  const { getEmailStatus } = await import("../server/email");
  assert.equal((await getEmailStatus()).tidyError, null);
});

test("when the Gmail API is off, it says how to turn it on and sending isn't affected", async () => {
  routes = (c) => (c.url.includes("/token") ? { status: 200, body: { access_token: "at" } } : { status: 403, body: { error: { status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }] } } });
  const { tidySentGmail } = await import("../server/emailGoogle");
  const r = await tidySentGmail(await cfg(), "<x@y>");
  assert.equal(r.ok, false);
  assert.match(r.error!, /Turn on the Gmail API/);
  const { getEmailStatus } = await import("../server/email");
  assert.match((await getEmailStatus()).tidyError!, /Gmail API/);
});
