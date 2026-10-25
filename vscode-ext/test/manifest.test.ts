import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string): string => readFileSync(ROOT + rel, "utf8");
const pkg = JSON.parse(read("package.json")) as {
  version: string;
  icon: string;
  activationEvents: string[];
  contributes: {
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[]; secondarySidebar?: { id: string; title: string; icon: string }[] };
    views: Record<string, { id: string; name: string; type: string }[]>;
    commands: { command: string; title: string }[];
    configuration: { properties: Record<string, unknown> };
    menus?: Record<string, { command: string }[]>;
  };
};
const nls = JSON.parse(read("package.nls.json")) as Record<string, string>;
const nlsJa = JSON.parse(read("package.nls.ja.json")) as Record<string, string>;

describe("manifest", () => {
  it("is version 1.0.0", () => {
    expect(pkg.version).toBe("1.0.0");
    expect(read("CHANGELOG.md")).toMatch(/^## 0\.2\.0/m);
  });

  it("contributes the OmniChat VS activity-bar container with an existing icon", () => {
    const container = pkg.contributes.viewsContainers.activitybar.find((c) => c.id === "omnichat");
    expect(container?.title).toBe("OmniChat VS");
    expect(existsSync(ROOT + (container?.icon ?? "missing"))).toBe(true);
    const svg = read(container?.icon ?? "");
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain("currentColor");
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b/i); // monochrome: the colour comes from VS Code
  });

  it("puts the Chat and Settings webview views in that container", () => {
    const views = pkg.contributes.views.omnichat ?? [];
    expect(views.map((v) => v.id)).toEqual(["omnichat.chat", "omnichat.settings"]);
    expect(views.every((v) => v.type === "webview")).toBe(true);
    for (const v of views) {
      const key = /^%(.+)%$/.exec(v.name)?.[1] ?? "";
      expect(nls[key], key).toBeTruthy();
      expect(nlsJa[key], key).toBeTruthy();
    }
    expect(Object.keys(pkg.contributes.views).sort()).toEqual(["omnichat", "omnichatRight"]);
  });

  it("contributes the chat to the right (secondary) side bar as a view container", () => {
    const container = pkg.contributes.viewsContainers.secondarySidebar?.find((c) => c.id === "omnichatRight");
    expect(container?.title).toBe("OmniChat VS");
    expect(existsSync(ROOT + (container?.icon ?? "missing"))).toBe(true);
    const views = pkg.contributes.views.omnichatRight ?? [];
    expect(views.map((v) => v.id)).toEqual(["omnichat.chatRight"]);
    expect(views[0]?.type).toBe("webview");
    expect(pkg.activationEvents).toContain("onView:omnichat.chatRight");
    expect(read("src/ui/chatView.ts")).toContain('CHAT_RIGHT_VIEW_ID = "omnichat.chatRight"');
    expect(read("src/ui/chatCommands.ts")).toContain("CHAT_RIGHT_VIEW_ID, chat.right.provider");
  });

  it("registers the right side bar command, which focuses the right view and falls back with a message", () => {
    expect(pkg.contributes.commands.map((c) => c.command)).toContain("omnichat.moveToSecondarySideBar");
    expect(read("src/ui/chatCommands.ts")).toContain("chat.focusRight()");
    expect(read("src/ui/chatView.ts")).toContain("CHAT_RIGHT_VIEW_ID + \".focus\"");
    expect(read("src/ui/chatView.ts")).toContain("s.rightDockUnsupported");
    expect(nlsJa["omnichat.cmd.moveToSecondarySideBar"]).toContain("右のサイドバーで開く");
    expect(nls["omnichat.cmd.moveToSecondarySideBar"]).toBe("OmniChat: Open Chat in the right side bar");
  });

  it("has a handler registered in extension.ts or chatCommands.ts for every contributed command", () => {
    const source = read("src/extension.ts") + read("src/ui/chatCommands.ts");
    for (const { command } of pkg.contributes.commands) {
      expect(source, command).toContain(`registerCommand("${command}"`);
    }
    for (const entries of Object.values(pkg.contributes.menus ?? {})) {
      for (const { command } of entries) {
        expect(pkg.contributes.commands.some((c) => c.command === command), command).toBe(true);
      }
    }
  });

  it("registers a provider for every contributed view and loads its script", () => {
    const source = read("src/extension.ts");
    expect(source).toContain("registerWebviewViewProvider(CHAT_VIEW_ID");
    expect(source).toContain("registerWebviewViewProvider(SETTINGS_VIEW_ID");
    expect(read("src/ui/chatCommands.ts")).toContain("registerWebviewViewProvider(CHAT_RIGHT_VIEW_ID");
    expect(read("src/ui/chatView.ts")).toContain('CHAT_VIEW_ID = "omnichat.chat"');
    expect(read("src/ui/settingsView.ts")).toContain('SETTINGS_VIEW_ID = "omnichat.settings"');
    for (const script of ["chat.js", "settings.js", "chat.css"]) {
      expect(existsSync(`${ROOT}media/webview/${script}`), script).toBe(true);
    }
  });

  it("localises every %key% in both languages and keeps the .vsix allowlist in sync", () => {
    const keys = [...JSON.stringify(pkg).matchAll(/"%([^%"]+)%"/g)].map((m) => m[1] as string);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(nls[key], key).toBeTruthy();
      expect(nlsJa[key], key).toBeTruthy();
    }
    const ignore = read(".vscodeignore");
    expect(ignore).toContain("!media/omnichat-activity.svg");
    expect(ignore).toContain("!package.nls*.json");
  });

  it("keeps the editor and dock buttons out of the webview header (the view title bar has them)", () => {
    const header = read("src/webview/chat/header.ts");
    expect(header).not.toContain("openInEditor");
    expect(header).not.toContain("dockRight");
    expect(header).toContain("tools.append(historyBtn, newBtn, settingsBtn)");
    expect(read("media/webview/chat.css")).toMatch(/\.ch-header__title \{\s*flex: 1 1 0;/);
  });

  it("declares the decorations setting", () => {
    expect(pkg.contributes.configuration.properties["omnichat.decorations"]).toMatchObject({ default: "auto" });
  });
});

describe("icon.png", () => {
  it("is a 128x128 PNG", () => {
    const bytes = readFileSync(ROOT + pkg.icon);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(128);
    expect(bytes.readUInt32BE(20)).toBe(128);
  });
});

describe("source size", () => {
  it("keeps the 0.2.0 view and chat sources at 300 lines or fewer", () => {
    const files = [
      "src/extension.ts",
      "src/protocol/chat-frames.ts",
      ...readdirSync(ROOT + "src/chat").map((f) => `src/chat/${f}`),
      ...["chatView", "settingsView", "settingsModel", "viewProvider", "strings", "panels"].map((f) => `src/ui/${f}.ts`),
    ];
    for (const file of files) {
      expect(read(file).split("\n").length, file).toBeLessThanOrEqual(301);
    }
  });
});
