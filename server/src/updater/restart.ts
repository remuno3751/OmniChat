/* Restart the server process so a new bundle (or restored data) takes effect. No db import. */
import { spawn } from "node:child_process";

/** Exit code the supervisors (Tauri server-app, service units) treat as "restart me". */
export const RESTART_EXIT_CODE = 75;

/**
 * Supervised (OMNICHAT_SUPERVISED=1, set by launchers and service units): exit with 75 and let the supervisor start us again.
 * Unsupervised: start a detached copy of this process (it waits OMNICHAT_START_DELAY_MS so the port is free), then exit 0.
 * If the copy cannot be spawned the current process keeps running.
 */
export function requestRestart(reason: string, log: (msg: string) => void = (m) => console.error(m)): void {
  log(`[update] restart requested: ${reason}`);
  if (process.env.OMNICHAT_SUPERVISED === "1") {
    // let pending console output reach the pipes before the exit
    let pending = 2;
    const done = () => process.exit(RESTART_EXIT_CODE);
    const dec = () => { if (--pending === 0) done(); };
    process.stdout.write("", dec);
    process.stderr.write("", dec);
    setTimeout(done, 1000).unref();
    return;
  }
  let child;
  try {
    child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OMNICHAT_START_DELAY_MS: "2500" },
    });
  } catch (e) {
    log(`[update] could not start the new process: ${(e as Error).message}`);
    return;
  }
  if (!child.pid) {
    log("[update] could not start the new process; staying up");
    return;
  }
  child.unref();
  process.exit(0);
}
