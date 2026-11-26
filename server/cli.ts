// Command line tools for the server operator:
//
//   node dist/index.cjs admin create --username NAME [--display-name "Full Name"] --password-stdin
//   node dist/index.cjs admin reset-password --username NAME --password-stdin
//   node dist/index.cjs admin list
//   node dist/index.cjs admin disable-2fa --username NAME
//
// They use the same DATA_DIR and database settings as the server.
import { initDatabase, closeDatabase } from "./db";
import { clearSetupCode } from "./auth";
import { ROLE_LABELS, UserError, createUser, findUserByName, listUsers, setUserPassword, updateProfile } from "./users";
import { audit, flushAudit } from "./audit";
import { disableTwoFactor } from "./twofactor";
import { z } from "zod";

export interface CliIO {
  /** Read all of standard input (only called with --password-stdin). */
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage:
  admin create --username NAME [--display-name "Full Name"] --password-stdin
      Create an owner account (works before or after first-run setup).
  admin reset-password --username NAME --password-stdin
      Set a new password, re-activate the account and sign it out everywhere.
  admin rename --from OLD --to NEW
      Change an account's sign-in username (password and sessions unchanged).
  admin list
      List user accounts: username, role, status, 2FA, display name.
  admin disable-2fa --username NAME
      Turn off two-factor sign-in for an account (lost phone and recovery codes).

The password is read from standard input, e.g.
  printf '%s' 'new password' | node dist/index.cjs admin create --username alex --password-stdin`;

function parseFlags(args: string[]) {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw new UserError(`Unexpected argument "${a}".`);
    const eq = a.indexOf("=");
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    if (name === "password-stdin" || name === "help") { flags[name] = true; continue; }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UserError(`--${name} needs a value.`);
    flags[name] = v;
    i++;
  }
  return flags;
}

async function readPassword(flags: Record<string, string | true>, io: CliIO) {
  if (flags["password-stdin"] !== true) throw new UserError("Pass the password on standard input with --password-stdin.");
  const raw = await io.readStdin();
  const pw = raw.replace(/\r?\n$/, "");
  if (!pw) throw new UserError("No password was given on standard input.");
  return pw;
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const cliActor = { userId: null, userName: "server command line", ip: "local" };

/** Run `admin <command> ...`. Returns the process exit code. */
export async function runAdminCli(args: string[], io: CliIO = defaultIO()): Promise<number> {
  const [cmd, ...rest] = args;
  try {
    if (!cmd || cmd === "help" || cmd === "--help") { io.out(USAGE); return cmd ? 0 : 2; }
    const flags = parseFlags(rest);
    await initDatabase();
    if (cmd === "list") {
      const users = await listUsers({ fresh: true });
      if (!users.length) { io.out("No user accounts yet. Run `admin create` or open the app to set it up."); return 0; }
      for (const u of users) {
        io.out([u.username.padEnd(20), ROLE_LABELS[u.role].padEnd(14), (u.active ? "active" : "inactive").padEnd(9), (u.twoFactor?.enabled ? "2FA" : "").padEnd(4), u.displayName, u.siteIds.length ? `(locations: ${u.siteIds.join(", ")})` : ""].join(" ").trimEnd());
      }
      return 0;
    }
    if (cmd === "create") {
      const username = str(flags.username);
      if (!username) throw new UserError("--username is required.");
      const password = await readPassword(flags, io);
      const user = await createUser(null, { username, displayName: str(flags["display-name"]), password, role: "owner" });
      clearSetupCode();
      audit({ ...cliActor, action: "user.create", target: `user:${user.id}`, detail: `${user.username}: Owner (command line)` });
      await flushAudit();
      io.out(`Created owner account "${user.username}".`);
      return 0;
    }
    if (cmd === "reset-password") {
      const username = str(flags.username);
      if (!username) throw new UserError("--username is required.");
      const password = await readPassword(flags, io);
      const user = await findUserByName(username);
      if (!user) throw new UserError(`No account named "${username}". Use \`admin list\` to see accounts.`);
      await setUserPassword(null, user.id, password, { reactivate: true });
      audit({ ...cliActor, action: "user.password", target: `user:${user.id}`, detail: `${user.username}: password reset (command line)` });
      await flushAudit();
      io.out(`Password for "${user.username}" updated. All of its sessions were signed out.`);
      return 0;
    }
    if (cmd === "rename") {
      const from = str(flags.from), to = str(flags.to);
      if (!from || !to) throw new UserError("--from and --to are required.");
      const user = await findUserByName(from);
      if (!user) throw new UserError(`No account named "${from}". Use \`admin list\` to see accounts.`);
      const updated = await updateProfile(user.id, { username: to });
      audit({ ...cliActor, action: "user.update", target: `user:${user.id}`, detail: `username ${user.username} → ${updated.username} (command line)` });
      await flushAudit();
      io.out(`Renamed "${user.username}" to "${updated.username}". Sign in with "${updated.username}" and the same password.`);
      return 0;
    }
    if (cmd === "disable-2fa") {
      const username = str(flags.username);
      if (!username) throw new UserError("--username is required.");
      const user = await findUserByName(username);
      if (!user) throw new UserError(`No account named "${username}". Use \`admin list\` to see accounts.`);
      if (!user.twoFactor?.enabled) { io.out(`Two-factor sign-in is already off for "${user.username}".`); return 0; }
      await disableTwoFactor(user.id);
      audit({ ...cliActor, action: "user.2fa-reset", target: `user:${user.id}`, detail: `${user.username}: two-factor sign-in turned off (command line)` });
      await flushAudit();
      io.out(`Two-factor sign-in is now off for "${user.username}". They can sign in with their password and set it up again.`);
      return 0;
    }
    io.err(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 2;
  } catch (err: any) {
    if (err instanceof z.ZodError) io.err(`Error: ${err.issues[0]?.message ?? "invalid input"}`);
    else io.err(`Error: ${err?.message ?? err}`);
    return 1;
  }
}

function defaultIO(): CliIO {
  return {
    readStdin: async () => {
      if (process.stdin.isTTY) process.stderr.write("Password (input is visible; end with Enter, then Ctrl-D): ");
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      return Buffer.concat(chunks).toString("utf8");
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}

/** Entry point from server/index.ts: run and exit. */
export async function runAdminCliAndExit(args: string[]) {
  const code = await runAdminCli(args);
  closeDatabase();
  process.exit(code);
}
