// Password hashing (scrypt) shared by sign-in, user management and the CLI.
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const MIN_PASSWORD = 8;

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

/** True when the stored value is a plain (pre-hashing) password that should be re-hashed. */
export const isLegacyPlain = (stored: string) => !stored.startsWith("scrypt$");

export async function verifyHash(pw: string, stored: string): Promise<boolean> {
  if (isLegacyPlain(stored)) return safeEqual(pw, stored); // legacy plain value
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, "base64url");
    const derived = await scrypt(pw, Buffer.from(salt, "base64url"), expected.length);
    return timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/** Spend the same time as a real check, so unknown usernames can't be told apart by timing. */
let dummy: string | null = null;
export async function burnHash(pw: string) {
  dummy ??= await hashPassword("not-a-real-password");
  await verifyHash(pw, dummy);
}
