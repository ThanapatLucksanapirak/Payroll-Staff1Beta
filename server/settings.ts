// App-level settings stored in the active database's key/value table.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  type Category, type EmployeeConfig, type Prefs, type Site, categorySchema, employeeConfigSchema, prefsSchema, siteSchema, siteRulesSchema,
} from "@shared/schema";
import { db } from "./db";
import type { DataStore } from "./db/types";

export const LEGACY_SITE_ID = "main";
const K = {
  sites: "sites",
  categories: "categories",
  prefs: "app_prefs",
  wages: (siteId: string) => `saved_wages:${siteId}`,
  square: (siteId: string) => `square_token:${siteId}`,
};

interface Cache { store: DataStore; sites?: Site[]; categories?: Category[]; prefs?: Prefs }
let cache: Cache | null = null;

async function c(): Promise<Cache> {
  const store = await db();
  if (!cache || cache.store !== store) cache = { store };
  return cache;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** First run on a database: create a location from the v1 settings. */
async function bootstrap(store: DataStore): Promise<Site[]> {
  const legacy = await store.getSettings(["clock_in_cutoff", "clock_out_cutoff", "password_hash", "saved_wages", "square_access_token"]);
  const isExisting = Object.keys(legacy).length > 0 || (await store.listTimesheets()).length > 0;
  const rules = siteRulesSchema.parse({
    clockInCutoff: Number.parseInt(legacy.clock_in_cutoff ?? "", 10) || undefined,
    clockOutCutoff: Number.parseInt(legacy.clock_out_cutoff ?? "", 10) || undefined,
  });
  const site = siteSchema.parse({ id: LEGACY_SITE_ID, name: "Main Location", rules });
  await store.setSetting(K.sites, JSON.stringify([site]));
  if (!(await store.getSetting(K.prefs)) && isExisting) {
    await store.setSetting(K.prefs, JSON.stringify(prefsSchema.parse({ defaultSiteId: LEGACY_SITE_ID })));
  }
  return [site];
}

export async function getSites(): Promise<Site[]> {
  const cc = await c();
  if (cc.sites) return cc.sites;
  const raw = await cc.store.getSetting(K.sites);
  let sites = parseJson<any[]>(raw, []).map((s) => siteSchema.safeParse(s)).filter((r) => r.success).map((r) => r.data!);
  if (!sites.length) sites = await bootstrap(cc.store);
  cc.sites = sites;
  return sites;
}

export async function saveSites(sites: Site[]) {
  const cc = await c();
  await cc.store.setSetting(K.sites, JSON.stringify(sites));
  cc.sites = sites;
}

export async function getSite(id: string): Promise<Site | undefined> {
  return (await getSites()).find((s) => s.id === id);
}

export async function defaultSiteId(): Promise<string> {
  const sites = await getSites();
  return sites.find((s) => s.id === LEGACY_SITE_ID)?.id ?? sites[0].id;
}

export async function createSite(input: Partial<Site>): Promise<Site> {
  const site = siteSchema.parse({ ...input, id: `site_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString() });
  await saveSites([...(await getSites()), site]);
  return site;
}

export async function updateSite(id: string, patch: Partial<Site>): Promise<Site | null> {
  const sites = await getSites();
  const i = sites.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const next = siteSchema.parse({ ...sites[i], ...patch, id, rules: { ...sites[i].rules, ...(patch.rules ?? {}) } });
  const all = [...sites];
  all[i] = next;
  await saveSites(all);
  return next;
}

export async function deleteSite(id: string): Promise<void> {
  const sites = await getSites();
  if (sites.length <= 1) throw Object.assign(new Error("You need at least one location."), { status: 400 });
  const store = (await c()).store;
  const used = (await store.listTimesheets()).some((t) => (t.siteId ?? LEGACY_SITE_ID) === id);
  if (used) throw Object.assign(new Error("This location still has saved timesheets. Move or delete them first, or archive the location instead."), { status: 409 });
  await saveSites(sites.filter((s) => s.id !== id));
  await store.deleteSetting(K.square(id)).catch(() => undefined);
  await store.deleteSetting(K.wages(id)).catch(() => undefined);
  const cats = await getCategories();
  if (cats.some((x) => x.siteId === id)) await saveCategories(cats.filter((x) => x.siteId !== id));
}

// ── Categories ────────────────────────────────────────────────────────────────
function legacyLocalCategories(): Category[] {
  const file = path.resolve(process.cwd(), "data.db");
  if (!fs.existsSync(file)) return [];
  try {
    const sqlite = new Database(file, { readonly: true, fileMustExist: true });
    const rows = sqlite.prepare("select id, name, full_day_rate, half_day_rate, is_net_pay from employee_categories").all() as any[];
    sqlite.close();
    return rows.map((r) => categorySchema.parse({
      id: String(r.id), name: r.name, siteId: null, payBasis: "day_rate",
      fullDayRate: (Number(r.full_day_rate) || 0) / 100, halfDayRate: (Number(r.half_day_rate) || 0) / 100, isNetPay: !!r.is_net_pay,
    }));
  } catch {
    return [];
  }
}

export async function getCategories(): Promise<Category[]> {
  const cc = await c();
  if (cc.categories) return cc.categories;
  const raw = await cc.store.getSetting(K.categories);
  let cats: Category[];
  if (raw == null) {
    cats = legacyLocalCategories();
    await cc.store.setSetting(K.categories, JSON.stringify(cats));
  } else {
    cats = parseJson<any[]>(raw, []).map((x) => categorySchema.safeParse(x)).filter((r) => r.success).map((r) => r.data!);
  }
  cc.categories = cats;
  return cats;
}

export async function saveCategories(cats: Category[]) {
  const cc = await c();
  const names = new Set<string>();
  for (const cat of cats) {
    const k = `${cat.siteId ?? "*"}|${cat.name.trim().toLowerCase()}`;
    if (names.has(k)) throw Object.assign(new Error(`Duplicate category name "${cat.name}".`), { status: 400 });
    names.add(k);
  }
  await cc.store.setSetting(K.categories, JSON.stringify(cats));
  cc.categories = cats;
}

// ── Preferences ───────────────────────────────────────────────────────────────
export async function getPrefs(): Promise<Prefs> {
  const cc = await c();
  if (cc.prefs) return cc.prefs;
  await getSites(); // bootstrap may write prefs
  const p = prefsSchema.safeParse(parseJson(await cc.store.getSetting(K.prefs), {}));
  cc.prefs = p.success ? p.data : prefsSchema.parse({});
  return cc.prefs;
}

export async function savePrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const cc = await c();
  const next = prefsSchema.parse({ ...(await getPrefs()), ...patch });
  await cc.store.setSetting(K.prefs, JSON.stringify(next));
  cc.prefs = next;
  return next;
}

// ── Saved wage profiles (per site) ────────────────────────────────────────────
export async function getWageProfile(siteId: string): Promise<EmployeeConfig[]> {
  const store = (await c()).store;
  let raw = await store.getSetting(K.wages(siteId));
  if (raw == null && siteId === LEGACY_SITE_ID) raw = await store.getSetting("saved_wages");
  return parseJson<any[]>(raw, [])
    .map((e) => employeeConfigSchema.safeParse({ ...e, adjustments: {}, bonuses: [], deductions: [] }))
    .filter((r) => r.success && r.data!.name)
    .map((r) => r.data!);
}

export async function saveWageProfile(siteId: string, entries: EmployeeConfig[]) {
  const slim = entries.map(({ name, categoryId, payBasis, fullDayRate, halfDayRate, hourlyRate, isNetPay, excluded }) => ({
    name, categoryId, payBasis, fullDayRate, halfDayRate, hourlyRate, isNetPay, excluded,
  }));
  await (await c()).store.setSetting(K.wages(siteId), JSON.stringify(slim));
  return slim.length;
}

// ── Square tokens (never sent to the browser) ─────────────────────────────────
export async function getSquareToken(siteId: string): Promise<string | null> {
  const store = (await c()).store;
  const t = await store.getSetting(K.square(siteId));
  if (t) return t;
  if (siteId === LEGACY_SITE_ID) return await store.getSetting("square_access_token");
  return null;
}

export async function setSquareToken(siteId: string, token: string | null) {
  const store = (await c()).store;
  if (token) await store.setSetting(K.square(siteId), token);
  else {
    await store.deleteSetting(K.square(siteId));
    if (siteId === LEGACY_SITE_ID) await store.deleteSetting("square_access_token");
  }
}

export function invalidateSettingsCache() {
  cache = null;
}
