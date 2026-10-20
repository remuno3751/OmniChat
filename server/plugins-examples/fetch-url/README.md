# fetch-url (example plugin)

Gives the model a `fetch_url` tool that downloads an http(s) page and returns plain text (max ~6000 characters). It declares the **network** permission, so OmniChat asks the user to approve each call (once / always / deny) and passes `ctx.fetch` to the tool only because of that declaration.

Install: copy this directory to `$DATA_DIR/plugins/fetch-url/`, then `POST /tools/reload` as an admin (or restart). Enable with `tools: ["fetch_url"]`.

> WARNING: plugins run in the server process with the server's full OS permissions; `permissions` are declarations for the approval prompt, not a sandbox. This example can request any URL reachable from the server (including LAN and localhost addresses), so only enable it for people you trust.
