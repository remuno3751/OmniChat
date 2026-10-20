# current-time (example plugin)

Gives the model a `current_time` tool. It declares **no permissions**, so it never asks for approval.

Install: copy this directory to `$DATA_DIR/plugins/current-time/` (so that `$DATA_DIR/plugins/current-time/plugin.json` exists), then call `POST /tools/reload` as an admin (or restart the server). Enable the tool per global settings / project / chat with `tools: ["current_time"]`.

> WARNING: plugins run in the server process with the server's full OS permissions. The `permissions` array in `plugin.json` is only a declaration used for the approval prompt; it is NOT a sandbox. Install only plugins you have read and trust.
