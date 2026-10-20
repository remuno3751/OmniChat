/* How this server was installed, and whether it may replace its own bundle. Pure: no db, no network. */
import { existsSync } from "node:fs";
import type { InstallType } from "./types.js";

export interface InstallInfo {
  type: InstallType;
  selfUpdate: boolean;
  reason: string | null;
  dockerCommand: string | null;
}

export const DOCKER_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

/** Values the launchers put in OMNICHAT_INSTALL_TYPE (docker and dev are detected here, never set by launchers). */
const LAUNCHER_TYPES: readonly InstallType[] = ["server-app", "windows-service", "linux-service", "macos-service", "tarball"];

/**
 * Decision matrix:
 * - Docker (OMNICHAT_DOCKER=1 or /.dockerenv): type docker, no self update, show the pull command.
 * - Run from source (entry is a .ts file, e.g. tsx src/index.ts) or no launcher type: type dev, no self update.
 * - Launcher type set and OMNICHAT_BOOT=1 (boot.js ran): self update allowed.
 * - Launcher type set but OMNICHAT_BOOT missing: launcher predates the update system, no self update.
 */
export function detectInstall(
  env: Record<string, string | undefined> = process.env,
  fsExists: (path: string) => boolean = existsSync,
  entry: string = process.argv[1] ?? "",
): InstallInfo {
  if (env.OMNICHAT_DOCKER === "1" || fsExists("/.dockerenv")) {
    return { type: "docker", selfUpdate: false, reason: "running in Docker: pull the new image to update", dockerCommand: DOCKER_UPDATE_COMMAND };
  }
  const dev = (reason: string): InstallInfo => ({ type: "dev", selfUpdate: false, reason, dockerCommand: null });
  if (/\.[cm]?ts$/i.test(entry)) return dev("running from source: self update is disabled");
  const t = (env.OMNICHAT_INSTALL_TYPE ?? "").trim() as InstallType;
  if (!LAUNCHER_TYPES.includes(t)) return dev("not started by an OmniChat launcher: self update is disabled");
  if (env.OMNICHAT_BOOT === "1") return { type: t, selfUpdate: true, reason: null, dockerCommand: null };
  return { type: t, selfUpdate: false, reason: "launcher predates the update system; install the new installer once", dockerCommand: null };
}
