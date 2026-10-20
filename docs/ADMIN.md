# Administering OmniChat from the client app

Admin accounts can manage the server from **Settings > Server** in any OmniChat client. The page is shown only to administrators, and only when the server reports `adminSettings: true` in `GET /version`. The server re-checks the admin role on every request; hiding the page is cosmetic. Route reference: `PROTOCOL-v7-admin.md`.

## What you can do
* **Overview**: name, version, uptime, user counts, install type, whether a supervisor restarts the server.
* **General**: server name and description (shown in `/version`), self-registration on/off (stored in the database, wins over the `ALLOW_REGISTRATION` environment default), web search backend, update channel / check interval / GitHub token (write-only).
* **Users**: list (role, disabled, last seen, devices, tokens used in the last 30 days), create user with a temporary password, reset password (signs the user out everywhere), enable/disable, promote/demote, sign out everywhere (devices and API keys), delete.
* **Network & security**: read-only host, port, exposure class (loopback / local network / all interfaces), proxy and CORS settings, TLS hint.
* **Maintenance**: restart the server, create/list/delete backups (metadata only), log tail with level filter, diagnostics export (Markdown, secrets masked).
* **Recent changes**: every admin change is stored in the `admin_audit` table and listed here.

## Safety rules
* The last enabled administrator cannot be demoted, disabled or deleted. You cannot disable or delete your own account.
* Delete is a **soft disable by default** (data kept, user signed out). A permanent delete needs the extra "also delete all their data" option AND typing the exact username.
* Secrets are never returned or logged: secret.key, provider and search API keys, the GitHub token, pairing tokens, device tokens, password hashes. Audit values for keys named like token/key/password/secret are stored as `***`.
* Mutations are rate limited per admin (30/min; account creation, password reset, delete and restart 10/min).

## Restart
Under a supervisor (`OMNICHAT_SUPERVISED=1`: server app, service units) the process exits with code 75 and is started again. Unsupervised, it starts a detached copy and exits. The client waits for the server to answer again.

## Not available remotely
* **Host and port** are read-only in the client. A wrong value could lock every remote admin out and there is no safe automatic rollback; change them on the server machine (server app, `config.env`, environment) and restart.
* **Restore from backup** stays local (server app).
* Default context length, compression thresholds, ephemeral idle time, model-load policy and ntfy notifications are per-user settings, not server-wide, so they are not on this page.
* The network TLS hint text comes from the server in English.
