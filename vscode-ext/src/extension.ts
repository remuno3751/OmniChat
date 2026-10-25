/**
 * Extension entry point: wiring only (spec docs/design/VSCODE-BRIDGE.md §9).
 * Commands, the status bar, the connection session, and the
 * "OmniChat VS" activity-bar views (Chat, Settings).
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as vscode from "vscode";
import { readConfig } from "./config";
import { createVscodeHost } from "./host/vscode";
import { checkPairing, type PairReason, type Pairing } from "./pairing";
import { createTokenStore } from "./secrets";
import { createSession } from "./session";
import { createLinkTracker } from "./chat/link";
import { createActivityFeed } from "./ui/activityFeed";
import { createActivityPanel } from "./ui/activityPanel";
import { createChatController } from "./chat/controller";
import { registerChatCommands } from "./ui/chatCommands";
import { createChatView, CHAT_VIEW_ID } from "./ui/chatView";
import { createSettingsView, SETTINGS_VIEW_ID } from "./ui/settingsView";
import { createStatusItem, type StatusItem, type StatusState } from "./ui/status";
import { pickLang, stringsFor } from "./ui/strings";

const INSTANCE_KEY = "omnichat.instanceId";
const MAX_NAME_CHARS = 64;

let teardown: (() => void) | undefined;

/** Stable per-install id, so the server sees the same bridge across restarts. */
function instanceId(context: vscode.ExtensionContext): string {
  const saved = context.globalState.get<string>(INSTANCE_KEY);
  if (saved) return saved;
  const id = randomUUID();
  void context.globalState.update(INSTANCE_KEY, id);
  return id;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OmniChat");
  // Never pass the token or pairing code to `log`.
  const log = (line: string): void => output.appendLine(`${new Date().toISOString()} ${line}`);
  const getConfig = (id: string): unknown => vscode.workspace.getConfiguration().get(id);
  const settings = () => readConfig(getConfig);
  const secrets = createTokenStore(context.secrets);
  const status: StatusItem = createStatusItem(vscode);
  const lang = pickLang(vscode.env.language);
  let paired = false;
  let connection: StatusState = "unpaired";
  const link = createLinkTracker(() => chat.update()); // round trip and reconnect, for the Chat view
  let pairing_ = false; // while true, configuration changes made by pairing do not reconnect on their own
  const version = String(context.extension.packageJSON.version ?? "0.0.0");

  const activity = createActivityPanel({
    vscode,
    extensionUri: context.extensionUri,
    getTheme: () => settings().theme,
  });
  const feed = createActivityFeed((run) => {
    activity.update(run);
    status.setRunning(run?.status === "running");
  });

  // Chat state (models, conversations, transcript) over the live bridge connection.
  const controller = createChatController({
    send: (frame) => current.send(frame),
    roots: () => host.roots,
    onChange: () => chat.update(),
  });
  // Pending approvals are answered inline in the Chat view. An answer goes back through the session.
  const chat = createChatView({
    vscode,
    extensionUri: context.extensionUri,
    controller,
    lang,
    getTheme: () => settings().theme,
    getDecorations: () => settings().decorations,
    isPaired: () => paired,
    getStatus: () => connection,
    getLink: () => link.info(), roots: () => host.roots,
    toggleSettings: () => void vscode.commands.executeCommand(settingsView.handle.isVisible() ? "workbench.action.closeSidebar" : SETTINGS_VIEW_ID + ".focus"),
    pair: (code) => pairWithCode(code),
    onReply: (reply) => current.answerApproval(reply),
    focus: () => void vscode.commands.executeCommand(CHAT_VIEW_ID + ".focus"),
    openSettings: () => void vscode.commands.executeCommand(SETTINGS_VIEW_ID + ".focus"), globalState: context.globalState,
  });
  const settingsView = createSettingsView({
    vscode,
    extensionUri: context.extensionUri,
    lang,
    version,
    getTheme: () => settings().theme,
    getDecorations: () => settings().decorations,
    readValues: () => {
      const text = (id: string): string => {
        const v = getConfig(id);
        return typeof v === "string" ? v : "";
      };
      const cfg = settings();
      return {
        serverUrl: cfg.serverUrl,
        deviceName: text("omnichat.deviceName"),
        theme: cfg.theme,
        decorations: cfg.decorations,
        autoSave: cfg.autoSave,
        shell: cfg.shell ?? "",
      };
    },
    isPaired: () => paired,
    getStatus: () => connection,
    pair: (code) => pairWithCode(code),
    runCommand: (id) => void vscode.commands.executeCommand(id),
  });
  const refreshViews = (): void => { chat.update(); settingsView.update(); };
  const host = createVscodeHost(vscode, { autoSave: () => settings().autoSave });
  const current = createSession({
    host,
    version,
    instance: instanceId(context),
    isTrusted: () => vscode.workspace.isTrusted,
    shell: () => settings().shell,
    log,
    onFrame: (frame) => {
      // Chat frames (models, conversations, transcript, prompt_ack, ...) belong to the Chat view's controller.
      controller.handleFrame(frame);
      feed.handle(frame);
    },
    approvals: {
      show: (input) => chat.approvals.show(input),
      dismiss: (approvalId) => chat.approvals.dismiss(approvalId),
      pendingChanged: (count) => status.setPending(count),
    },
    onWelcome: (frame) => controller.setServerInfo({ serverVersion: frame.serverVersion, features: frame.features }),
    onLatency: link.onLatency,
    onStatus: (state, detail, retry) => {
      // A run cannot outlive its connection: end it before the status bar is redrawn.
      if (state !== "online") feed.interrupt("disconnected");
      status.set(state, detail);
      connection = state; link.onStatus(state, retry);
      controller.setOnline(state === "online");
      refreshViews();
      log(`connection: ${state}${detail ? ` (${detail.slice(0, 200)})` : ""}`);
    },
  });
  teardown = () => { current.stop(); controller.dispose(); };

  /** Connects with the stored token and server URL, or shows "not paired". */
  const connectStored = async (): Promise<void> => {
    const token = await secrets.get();
    const { serverUrl } = settings();
    if (!token || !serverUrl) {
      current.stop();
      paired = false;
      connection = "unpaired";
      status.set("unpaired");
      controller.setOnline(false);
      refreshViews();
      return;
    }
    paired = true;
    const configuredName = getConfig("omnichat.deviceName");
    const name =
      typeof configuredName === "string" && configuredName.trim() !== ""
        ? configuredName.trim().slice(0, MAX_NAME_CHARS)
        : hostname() || "VS Code";
    current.start({ serverUrl, token, name });
  };

  /** Stores a validated pairing, then connects. Errors are logged generically. */
  const pairWith = async (pairing: Pairing): Promise<void> => {
    pairing_ = true;
    try {
      await secrets.set(pairing.token);
      const config = vscode.workspace.getConfiguration();
      await config.update("omnichat.serverUrl", pairing.serverUrl, vscode.ConfigurationTarget.Global);
      await config.update("omnichat.deviceName", pairing.name, vscode.ConfigurationTarget.Global);
      log(`paired with ${new URL(pairing.serverUrl).host} as "${pairing.name}"`);
      await connectStored();
    } catch {
      log("pairing failed; the token was not stored");
      void vscode.window.showErrorMessage("OmniChat: pairing failed. See the OmniChat log.");
    } finally {
      pairing_ = false;
    }
  };

  /** Pairs with a code pasted into a view. Returns the failure reason, or null on success. */
  const pairWithCode = async (code: string): Promise<PairReason | null> => {
    const parsed = checkPairing(code);
    if (!parsed.ok) return parsed.reason;
    await pairWith(parsed.pairing);
    return null;
  };

  registerChatCommands(vscode, context, chat);
  context.subscriptions.push(
    output,
    status,
    activity,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chat.handle.provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(SETTINGS_VIEW_ID, settingsView.handle.provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => current.stop() },

    vscode.commands.registerCommand("omnichat.showActivity", () => activity.reveal()),

    vscode.commands.registerCommand("omnichat.openChat", () => vscode.commands.executeCommand(CHAT_VIEW_ID + ".focus")),
    vscode.commands.registerCommand("omnichat.openSettings", () => vscode.commands.executeCommand(SETTINGS_VIEW_ID + ".focus")),
    vscode.commands.registerCommand("omnichat.newConversation", () => {
      controller.newConversation();
      return vscode.commands.executeCommand(CHAT_VIEW_ID + ".focus");
    }),

    vscode.commands.registerCommand("omnichat.pair", async () => {
      const code = await vscode.window.showInputBox({
        prompt: "Paste the pairing code from the OmniChat app",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => {
          const res = checkPairing(value);
          return res.ok ? undefined : stringsFor(lang).pairReasons[res.reason];
        },
      });
      if (code === undefined) return;
      const res = checkPairing(code);
      if (!res.ok) {
        void vscode.window.showErrorMessage(`OmniChat: ${stringsFor(lang).pairReasons[res.reason]}`);
        return;
      }
      await pairWith(res.pairing);
    }),

    vscode.commands.registerCommand("omnichat.unpair", async () => {
      try {
        await secrets.delete();
      } catch {
        log("unpair: could not delete the stored token");
      }
      current.stop();
      paired = false;
      connection = "unpaired";
      status.set("unpaired");
      controller.setOnline(false);
      refreshViews();
      log("unpaired. Revoke the device in the OmniChat app as well.");
    }),

    vscode.commands.registerCommand("omnichat.showLog", () => output.show(true)),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      current.refreshWorkspaces();
      controller.refresh();
      refreshViews();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("omnichat")) return;
      if (!pairing_ && (e.affectsConfiguration("omnichat.serverUrl") || e.affectsConfiguration("omnichat.deviceName"))) {
        connectStored().catch(() => log("settings: could not reconnect"));
      }
      if (e.affectsConfiguration("omnichat.theme") || e.affectsConfiguration("omnichat.decorations")) {
        chat.handle.refresh();
        settingsView.handle.refresh();
      } else {
        refreshViews();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      // Restart so the ready frame advertises the full tool list for the trusted window.
      current.restart();
    }),
  );

  connectStored().catch(() => log("startup: could not read the stored pairing"));
}

export function deactivate(): void {
  teardown?.();
  teardown = undefined;
}
