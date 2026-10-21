export const VERSION = "omnichat-cli 0.1.0";

export const HELP = `omnichat — command-line client for the OmniChat server

Usage: omnichat <command> [options]

Commands:
  login                      sign in and save server + token (see --server, --username)
  logout                     revoke this device and forget the saved login
  whoami                     show the server, user and current device
  models [--provider NAME]   list models as <providerName>/<modelId>
  chat "<message>"           send a message and stream the answer (also reads stdin)
  history [--limit N]        list recent conversations
  show <conversationId>      print the current branch of a conversation
  search "<query>"           full-text search over your history
  export <conversationId>    export a conversation (--format md|json, -o FILE)
  bench run <set>            run a benchmark set against targets (--targets A/B,C/D)
  config export|import       export/import the portable configuration (file or stdin)
  doctor [--data-dir DIR]    check the local setup, server reachability and server diagnostics

Global options:
  --server URL      server to use (default: saved config or $OMNICHAT_SERVER)
  --timeout SECS    request timeout (default 30)
  --debug           log requests to stderr (secrets are redacted)
  --no-color        disable colours (also NO_COLOR=1)
  -q, --quiet       suppress informational messages on stderr
  -h, --help        show help (add a command name for its options)
  -v, --version     print the version

Environment:
  OMNICHAT_SERVER, OMNICHAT_TOKEN, OMNICHAT_PASSWORD, OMNICHAT_USERNAME, OMNICHAT_CONFIG (config file path)

Exit codes: 0 ok, 1 error, 2 usage error, 130 interrupted (Ctrl+C).
`;

const CMD_HELP = {
  login: `omnichat login --server URL [--username U] [--register]
  Password: prompt (no echo) on a terminal, first line of stdin otherwise, or $OMNICHAT_PASSWORD.`,
  logout: "omnichat logout\n  Revokes the CLI device on the server and removes the saved token.",
  whoami: "omnichat whoami [--json]",
  models: "omnichat models [--provider NAME] [--all] [--json]",
  chat: `omnichat chat "<message>" [options]
  --model <providerName>/<modelId>   pick a model (default: conversation/project/first provider)
  --project NAME [--create-project]  file the conversation under a project
  --conv ID | --new                  continue a conversation (id or unique prefix) or start one
  --effort low|medium|high|max       reasoning effort for this message
  --search off|smart|always          web search mode (smart = model decides; auto = alias of smart)
  --system "<text>"                  system prompt for this conversation
  --thinking                         print thinking to stderr
  --approve once|always|deny         answer tool approvals without asking (default: deny)
  --json                             print {conversationId,status,message,metrics} as JSON
  --stats                            print ttft / decode speed to stderr
  --no-sources                       do not print the source list
  --idle-timeout SECS                give up after this long without data (default 300)
  Message: argument, "-" or piped stdin (both: joined with a blank line).
  Ctrl+C asks the server to stop the reply and exits 130.`,
  history: "omnichat history [--limit N] [--project NAME] [--json]",
  show: "omnichat show <conversationId> [--thinking] [--json]",
  search: "omnichat search \"<query>\" [--limit N] [--offset N] [--project NAME] [--json]",
  export: "omnichat export <conversationId> [--format md|json] [-o FILE|-] [--reasoning] [--all-branches]",
  bench: `omnichat bench run <setName|setId> --targets "<providerName>/<modelId>,..." [options]
  --repeats N (1..5, default 1)  --max-tokens N (default 256)  --no-warmup
  Prints the summary table when the run finishes. Ctrl+C cancels the run.`,
  doctor: `omnichat doctor [--server URL] [--data-dir DIR]
  Works without login. Exit 0 when no check fails (WARN is allowed), 1 otherwise.
  The server part needs an admin token (saved login or OMNICHAT_TOKEN).`,
  config: `omnichat config export [FILE] [--format json|yaml]   (stdout when FILE is omitted)
omnichat config import [FILE|-] [--mode merge|replace]    (YAML when FILE ends in .yaml/.yml)`,
};

export function commandHelp(name) {
  const h = CMD_HELP[name];
  return h ? `${h}\n` : null;
}
