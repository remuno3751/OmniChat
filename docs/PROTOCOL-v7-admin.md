# PROTOCOL v7 - remote server administration (additive)

Admin accounts can manage the server from the client app. Everything is optional: an old client ignores it, an old server simply does not report the capability.

## Capability
`GET /version` gains `adminSettings: true`, `serverName: string`, `serverDescription: string`. The client shows Settings > Server only when the signed-in user is an admin (`isAdmin` from the login response) AND `/version.adminSettings === true`. The server enforces the admin check on EVERY route below (the UI gate is cosmetic).

## Authentication, errors, limits
* All routes: `Authorization: Bearer <device token>`. No token / bad token -> `401 {error}`. Valid non-admin (or disabled) user -> `403 {error:"Admin only"}`.
* Validation errors -> `400 {error}`; unknown user -> `404`; conflicts (duplicate name, last admin, self-lockout) -> `409`; rate limit -> `429`.
* Mutations (every POST/PUT/PATCH/DELETE below) share a per-admin limit of 30 per minute -> `429 {error:"Too many admin changes, slow down"}`. Account creation, password reset and delete additionally 10 per minute.
* Secrets are never returned: no `secret.key`, provider/search API keys, GitHub token, pairing tokens, device tokens or password hashes. Booleans such as `githubTokenSet` are used instead.

## Routes (new)
| Route | Body / query | Response |
|---|---|---|
| `GET /admin/overview` | - | `{server:{name,description,version,installType,uptimeSec,supervised,platform,node}, users:{total,admins,disabled}, restartPending:false}` |
| `GET /admin/settings` | - | `{general:{serverName,serverDescription,allowRegistration,allowRegistrationSource:"db"\|"env"}}` |
| `PUT /admin/settings` | any of `{serverName: string 0..60, serverDescription: string 0..280, allowRegistration: boolean}`; unknown keys -> 400; empty body -> 400 | same as GET |
| `GET /admin/users` | - | `{users:[{id,username,role:"admin"\|"user",disabled,createdAt,lastSeenAt:number\|null,devices,tokens30d}], you:string}` (`you` = caller id; `tokens30d` = prompt+completion tokens from `metrics` over the last 30 days) |
| `POST /admin/users` | `{username 3..32, password >=8, role?:"admin"\|"user"}` | `201 {id,username,role}` |
| `PATCH /admin/users/:id` | `{role?:"admin"\|"user", disabled?:boolean}` | `{ok:true}`; cannot disable yourself (409); cannot demote/disable the last enabled admin (409) |
| `POST /admin/users/:id/password` | `{password >=8}` | `{ok:true, revokedDevices:n}` (all of the user's devices are revoked; for yourself the current device is kept) |
| `POST /admin/users/:id/revoke` | `{}` | `{ok:true, revokedDevices:n, revokedKeys:n}` (devices + API keys; for yourself the current device is kept) |
| `DELETE /admin/users/:id` | `{confirm: <exact username>, hard?: boolean}` | default (hard absent/false): soft-disable + revoke, data kept: `{ok:true, mode:"disabled"}`. `hard:true`: permanently removes the user and ALL their data (conversations, messages, providers, projects, settings, devices, keys, usage rows): `{ok:true, mode:"deleted"}`. Wrong `confirm` -> 400. Never yourself (409), never the last enabled admin (409). |
| `GET /admin/network` | - | `{host,port,exposure:"loopback"\|"lan"\|"all",trustProxy,corsOrigins:string[],tlsHint:string,editable:false}`; host/port are READ-ONLY here (see below) |
| `POST /admin/restart` | `{confirm:true}` (else 400) | `202 {ok:true, mode:"supervised"\|"respawn"}`; the process restarts ~700 ms later using the updater mechanism (`requestRestart`: exit code 75 under a supervisor, otherwise a detached respawn) |
| `GET /admin/logs` | `?level=all\|error\|warn\|info` (default all), `?lines=1..200` (default 100) | `{lines:string[]}` newest last, already secret-masked |
| `GET /admin/audit` | `?limit=1..200` (default 50) | `{entries:[{id,at,actorId,actor,action,key,oldValue,newValue}]}` newest first |

## Routes reused (already existing, all admin-only for writes)
* Search: `GET /search/config`, `PUT /search/config`, `POST /search/test`, `GET /search/status`.
* Updates: `GET /update/status`, `PUT /update/config` (`channel`, `checkHours`, `githubToken` write-only), `POST /update/check`, `POST /update/apply`.
* Backups: `POST /admin/backup`, `GET /admin/backups` (metadata; the client lists and can delete, never restores), `DELETE /admin/backups/:name`, `GET /admin/backups/:name` (download file; the client only shows metadata). Restore stays local-only (server app).
* Diagnostics: `GET /admin/diagnostics` (Markdown).
* These existing mutating routes now also write audit rows (`search.config`, `update.config`, `backup.create`, `backup.delete`).

## Audit
Table `admin_audit(id INTEGER PK AUTOINCREMENT, at INTEGER, actor_id TEXT, actor_name TEXT, action TEXT, key TEXT, old_value TEXT, new_value TEXT)`. One row per changed key: `action` is a dotted verb (`settings.update`, `user.create`, `user.role`, `user.disable`, `user.enable`, `user.password`, `user.revoke`, `user.delete`, `server.restart`, `search.config`, `update.config`, `backup.create`, `backup.delete`), `key` the changed field or the target user name. Values for keys matching `/token|key|password|secret|hash/i` are stored as `***` (or `set`/`unset`); other values are clipped to 200 chars. Password values are never recorded.

## Settings scope (what is "server" and what is per user)
* Server-wide, editable here: server name/description, registration on/off (DB value wins over the `ALLOW_REGISTRATION` env default), search backend config, update settings.
* Per user, NOT server-wide (so not editable here): default context length, compression thresholds, ephemeral idle minutes, model-load policy, ntfy notification URL. They live in each user's own Settings.

## Host / port
Read-only in the client. Changing `HOST`/`PORT` remotely could lock every remote admin out and there is no safe automatic rollback for a listener the admin can no longer reach, so it stays a local operation (server app, `config.env`, environment). The page shows the current values, the exposure class and hints.

## Client i18n keys
Prefix `admin.` (strings in `app/src/i18n/adminStrings*.ts`, merged into en.ts/ja.ts).
