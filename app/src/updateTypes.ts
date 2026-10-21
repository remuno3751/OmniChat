/**
 * Client wire types for the server update system (GET /update/status and friends).
 * Mirrors the server contract (section 2 of the update contract) exactly. Keep in sync with the server.
 */

export type Channel = 'stable' | 'prerelease';

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  /** API asset url */
  url: string;
  /** browser_download_url */
  downloadUrl: string;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  /** release notes, at most 20000 chars */
  notes: string;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export type UpdateErrorCode =
  | 'network'
  | 'not-found'
  | 'forbidden'
  | 'unauthorized'
  | 'rate-limited'
  | 'bad-response'
  | 'checksum-missing'
  | 'checksum-mismatch'
  | 'download'
  | 'unsupported'
  | 'bundle-invalid'
  | 'busy'
  | 'other';

export interface UpdateError {
  code: UpdateErrorCode;
  message: string;
  /** epoch ms */
  at: number;
}

export type InstallType = 'server-app' | 'windows-service' | 'linux-service' | 'macos-service' | 'tarball' | 'docker' | 'dev';

export type Phase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'staging' | 'backing-up' | 'restarting' | 'error';

export interface ApplyResult {
  status: 'ok' | 'failed';
  version: string;
  message: string;
  /** epoch ms */
  at: number;
  acknowledged: boolean;
  rolledBack?: boolean;
}

export interface PluginInfo {
  version: string;
  assetName: string;
  downloadUrl: string;
}

/** GET /update/status */
export interface UpdateStatus {
  current: string;
  installType: InstallType;
  selfUpdate: boolean;
  selfUpdateReason: string | null;
  /** set for docker installs, e.g. "docker compose pull && docker compose up -d" */
  dockerCommand: string | null;
  channel: Channel;
  checkHours: number;
  tokenSet: boolean;
  /** newest release visible on `channel` (any version, newer or not) */
  latest: ReleaseInfo | null;
  /** latest.version > current (semver, prerelease rules) */
  updateAvailable: boolean;
  /** latest.version is in the server skip list */
  skipped: boolean;
  skippedVersions: string[];
  /** latest has a server bundle zip AND a checksum for it */
  bundleAssetFound: boolean;
  lastCheckedAt: number | null;
  lastError: UpdateError | null;
  phase: Phase;
  /** 0..1 while downloading */
  progress: number | null;
  /** unacknowledged failure/rollback or recent success (see ack) */
  lastApply: ApplyResult | null;
  /** newest omnichat-dsh-bridge tgz found in `latest` */
  plugin: PluginInfo | null;
  /** newest omnichat-vscode .vsix found in `latest` (absent on an older server) */
  vsix?: PluginInfo | null;
  isAdmin: boolean;
}
