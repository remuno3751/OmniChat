// Account administration on the server machine (no HTTP, no token: access to the data directory is the authority).
//   node dist/admin-cli.js create <username> [--role admin|user]
//   node dist/admin-cli.js list
//   node dist/admin-cli.js set-password <username>
//   node dist/admin-cli.js role <username> admin|user
//   node dist/admin-cli.js disable <username>   |   enable <username>
// The password is read from OMNICHAT_ADMIN_PASSWORD, or prompted on a terminal (input hidden), or read from stdin.
// Uses the same environment as the server (DATA_DIR / DB_PATH).
import { createInterface } from "node:readline";
import { AuthError, createUserDirect, setPassword } from "./auth.js";
import { db } from "./db.js";
import { listUsers, setDisabled, setRole } from "./users-admin.js";

function readPassword(prompt: string): Promise<string> {
  const fromEnv = process.env.OMNICHAT_ADMIN_PASSWORD;
  if (fromEnv) return Promise.resolve(fromEnv);
  return new Promise((resolve) => {
    const tty = process.stdin.isTTY;
    const out = { write: (s: string) => { if (!tty) return true; return process.stderr.write(s); } };
    const rl = createInterface({ input: process.stdin, output: out as any, terminal: !!tty });
    if (tty) {
      // hide what is typed
      (rl as any)._writeToOutput = (s: string) => { if (s.includes(prompt)) process.stderr.write(s); };
    }
    rl.question(prompt, (a) => { rl.close(); if (tty) process.stderr.write("\n"); resolve(a); });
  });
}

function idOf(username: string): string {
  const r = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username) as { id: string } | undefined;
  if (!r) throw new AuthError(`No such user: ${username}`, 404);
  return r.id;
}

const usage = () => {
  console.error("usage: node dist/admin-cli.js create <username> [--role admin|user] | list | set-password <username> | role <username> admin|user | disable <username> | enable <username>");
  process.exit(2);
};

async function main(): Promise<void> {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  switch (cmd) {
    case "create": {
      if (!a1) return usage();
      // the first account on a fresh server is the administrator; later ones default to regular users
      const role = a2 === "--role" ? a3 : listUsers().length === 0 ? "admin" : "user";
      if (role !== "admin" && role !== "user") return usage();
      const pw = await readPassword("Password (8+ characters): ");
      const u = await createUserDirect(a1, pw, role === "admin");
      console.log(`created ${u.username} (${role})`);
      return;
    }
    case "list":
      for (const u of listUsers()) console.log(`${u.username}\t${u.role}${u.disabled ? "\tdisabled" : ""}\t${u.devices} device(s)`);
      return;
    case "set-password":
      if (!a1) return usage();
      await setPassword(idOf(a1), await readPassword("New password (8+ characters): "));
      console.log("password changed; the user was signed out everywhere");
      return;
    case "role":
      if (!a1 || !a2) return usage();
      setRole(idOf(a1), a2);
      console.log("ok");
      return;
    case "disable":
    case "enable":
      if (!a1) return usage();
      setDisabled(idOf(a1), cmd === "disable");
      console.log("ok");
      return;
    default:
      return usage();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof AuthError ? e.message : e); process.exit(1); });
