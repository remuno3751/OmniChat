// Shared types for the update system. Mirrored on the client in app/src/updateTypes.ts.

export type Channel = "stable" | "prerelease";

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  url: string; // API asset url (used with a token)
  downloadUrl: string; // browser_download_url (used without a token)
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  notes: string; // <= 20000 chars
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export type UpdateErrorCode =
  | "network"
  | "not-found"
  | "forbidden"
  | "unauthorized"
  | "rate-limited"
  | "bad-response"
  | "checksum-missing"
  | "checksum-mismatch"
  | "download"
  | "unsupported"
  | "bundle-invalid"
  | "busy"
  | "other";

export interface UpdateError {
  code: UpdateErrorCode;
  message: string;
  at: number;
}

export type InstallType =
  | "server-app"
  | "windows-service"
  | "linux-service"
  | "macos-service"
  | "tarball"
  | "docker"
  | "dev";

export type Phase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "staging"
  | "backing-up"
  | "restarting"
  | "error";

export interface ApplyResult {
  status: "ok" | "failed";
  version: string;
  message: string;
  at: number;
  acknowledged: boolean;
  rolledBack?: boolean;
}

export interface PluginInfo {
  version: string;
  assetName: string;
  downloadUrl: string;
}

export interface UpdateStatus {
  // GET /update/status
  current: string;
  installType: InstallType;
  selfUpdate: boolean;
  selfUpdateReason: string | null;
  dockerCommand: string | null; // set for docker installs, e.g. "docker compose pull && docker compose up -d"
  channel: Channel;
  checkHours: number;
  tokenSet: boolean;
  latest: ReleaseInfo | null; // newest release visible on `channel` (any version, newer or not)
  updateAvailable: boolean; // latest.version > current (semver, prerelease rules)
  skipped: boolean; // latest.version is in the server skip list
  skippedVersions: string[];
  bundleAssetFound: boolean; // latest has a server bundle zip AND a checksum for it
  lastCheckedAt: number | null;
  lastError: UpdateError | null;
  phase: Phase;
  progress: number | null; // 0..1 while downloading
  lastApply: ApplyResult | null; // unacknowledged failure/rollback or recent success (see ack)
  plugin: PluginInfo | null; // newest omnichat-dsh-bridge tgz found in `latest`
  isAdmin: boolean;
}
