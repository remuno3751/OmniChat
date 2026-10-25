/**
 * Chat wording added with the server-chat fixes: the error table, banners, history and the approval
 * mode hints. Kept apart from strings.ts (which holds the rest) to keep both files small.
 * `Strings` in strings.ts extends `ChatStrings`, and both languages must have the same keys.
 */
export interface ChatStrings {
  /** Shown when VS Code cannot open the right side bar chat (older versions). */
  rightDockUnsupported: string;
  errors: Record<
    | "generic"
    | "busy"
    | "confirm_required"
    | "not_ready"
    | "send_failed"
    | "timeout"
    | "unsupported"
    | "no_models"
    | "no_model"
    | "forbidden_model"
    | "quota"
    | "workspace_not_open"
    | "outdated"
    | "not_found"
    | "invalid_frame",
    string
  >;
  /** Banner when the server is too old for chat. */
  unsupportedServer: string;
  /** Banner when the server has no models. */
  noModels: string;
  history: string;
  recentTitle: string;
  noHistory: string;
  newChat: string;
  untitled: string;
  loadingConversation: string;
  sending: string;
  continueHint: string;
  copy: string;
  copied: string;
  thinking: string;
  /** The collapsed reasoning row once the run is done. */
  thought: string;
  modelLabel: string;
  modeLabel: string;
  modeManualHint: string;
  modeAutoHint: string;
  modeFullHint: string;
  selectModel: string;
  toolDuration: string;
  diffTruncated: string;
  /** Timeline wording per tool: past tense when finished, progressive while running. */
  toolDone: Record<ToolKey, string>;
  toolRunning: Record<ToolKey, string>;
  /** Fallbacks for unknown tools; "{tool}" is replaced by the tool name. */
  toolDoneOther: string;
  toolRunningOther: string;
  /** Tooltip of a clickable file path. */
  openFile: string;
  /** Folded run of one tool, e.g. "Read file · 4"; "{label}" and "{n}" are replaced. */
  toolGroup: string;
  /** Header button: move the chat to the right-hand (secondary) side bar. */
  dockRight: string;
}

export type ToolKey =
  | "read_file"
  | "list_dir"
  | "glob"
  | "grep"
  | "get_diagnostics"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_commit"
  | "edit_file"
  | "write_file"
  | "run_command";

export const chatJa: ChatStrings = {
  rightDockUnsupported: "この VS Code バージョンでは右のサイドバーに表示できません。OmniChat VS のアイコンを右端にドラッグしてください。",
  errors: {
    generic: "送信できませんでした。",
    busy: "別の実行が進行中です。",
    confirm_required: "フルアクセスには確認が必要です。",
    not_ready: "サーバーに接続していません。",
    send_failed: "送信できませんでした。接続を確認してください。",
    timeout: "サーバーから応答がありません(10秒)。サーバーが古い、または接続が不安定な可能性があります。",
    unsupported: "このサーバーはチャットに対応していません。",
    no_models: "モデルがありません。OmniChat アプリで OpenAI 互換のプロバイダーを追加してください。",
    no_model: "モデルを選択してください。",
    forbidden_model: "このモデルは使用が許可されていません。別のモデルを選んでください。",
    quota: "利用上限に達しました。時間をおいてから再度お試しください。",
    workspace_not_open: "この VS Code ウィンドウのフォルダーが開かれていません",
    outdated: "この拡張はサーバーに対して古すぎます。VS Code 拡張を更新してください。",
    not_found: "会話が見つかりません。削除された可能性があります。",
    invalid_frame: "サーバーから読み取れないデータが届きました。",
  },
  unsupportedServer: "このサーバーは VS Code のチャットに未対応です。サーバーを 0.5.4-beta.2 以降に更新してください",
  noModels: "モデルがありません: OmniChat アプリで OpenAI 互換のプロバイダーを追加してください",
  history: "履歴",
  recentTitle: "最近の会話",
  noHistory: "まだ会話がありません。",
  newChat: "新しい会話",
  untitled: "無題の会話",
  loadingConversation: "会話を読み込んでいます…",
  sending: "送信中…",
  continueHint: "この会話の続きとして送信されます",
  copy: "コピー",
  copied: "コピーしました",
  thinking: "考え中…",
  thought: "考えました",
  modelLabel: "モデル",
  modeLabel: "承認モード",
  modeManualHint: "ツールの実行前に毎回確認します",
  modeAutoHint: "安全な操作は自動で承認します",
  modeFullHint: "保護項目以外は確認なしで実行します",
  selectModel: "モデルを選択",
  toolDuration: "所要時間",
  diffTruncated: "… 以降の変更は省略しました",
  toolDone: {
    read_file: "ファイルを読みました",
    list_dir: "フォルダーを一覧しました",
    glob: "globを実行しました",
    grep: "grepを実行しました",
    get_diagnostics: "診断を取得しました",
    git_status: "git statusを実行しました",
    git_diff: "git diffを実行しました",
    git_log: "git logを実行しました",
    git_commit: "git commitを実行しました",
    edit_file: "ファイルを編集しました",
    write_file: "ファイルを書き込みました",
    run_command: "コマンドを実行しました",
  },
  toolRunning: {
    read_file: "ファイルを読み込み中…",
    list_dir: "フォルダーを一覧中…",
    glob: "globを実行中…",
    grep: "grepを実行中…",
    get_diagnostics: "診断を取得中…",
    git_status: "git statusを実行中…",
    git_diff: "git diffを実行中…",
    git_log: "git logを実行中…",
    git_commit: "git commitを実行中…",
    edit_file: "ファイルを編集中…",
    write_file: "ファイルを書き込み中…",
    run_command: "コマンドを実行中…",
  },
  toolDoneOther: "{tool}を実行しました",
  toolRunningOther: "{tool}を実行中…",
  openFile: "エディターで開く",
  toolGroup: "{label} · {n} 件",
  dockRight: "右のサイドバーに移動",
};

export const chatEn: ChatStrings = {
  rightDockUnsupported: "This VS Code version cannot dock views on the right. Drag the OmniChat VS icon to the right edge instead.",
  errors: {
    generic: "Could not send.",
    busy: "Another run is in progress.",
    confirm_required: "Full access needs confirmation.",
    not_ready: "Not connected to the server.",
    send_failed: "Could not send. Check the connection.",
    timeout: "No answer from the server (10 s). The server may be outdated or the connection unstable.",
    unsupported: "This server does not support chat.",
    no_models: "No models available. Add an OpenAI-compatible provider in the OmniChat app.",
    no_model: "Choose a model first.",
    forbidden_model: "This model is not allowed. Choose another model.",
    quota: "Usage limit reached. Try again later.",
    workspace_not_open: "The folder for this VS Code window is not open.",
    outdated: "This extension is too old for the server. Update the VS Code extension.",
    not_found: "The conversation was not found. It may have been deleted.",
    invalid_frame: "The server sent data this extension could not read.",
  },
  unsupportedServer: "This server does not support chat in VS Code. Update the server to 0.5.4-beta.2 or later.",
  noModels: "No models available: add an OpenAI-compatible provider in the OmniChat app.",
  history: "History",
  recentTitle: "Recent conversations",
  noHistory: "No conversations yet.",
  newChat: "New chat",
  untitled: "Untitled conversation",
  loadingConversation: "Loading conversation…",
  sending: "Sending…",
  continueHint: "Sent as a continuation of this conversation",
  copy: "Copy",
  copied: "Copied",
  thinking: "Thinking…",
  thought: "Thought",
  modelLabel: "Model",
  modeLabel: "Approval mode",
  modeManualHint: "Asks before each tool runs",
  modeAutoHint: "Approves safe operations automatically",
  modeFullHint: "Runs everything except protected items without asking",
  selectModel: "Select a model",
  toolDuration: "Duration",
  diffTruncated: "… remaining changes omitted",
  toolDone: {
    read_file: "Read file",
    list_dir: "Listed folder",
    glob: "Ran glob",
    grep: "Ran grep",
    get_diagnostics: "Got diagnostics",
    git_status: "Ran git status",
    git_diff: "Ran git diff",
    git_log: "Ran git log",
    git_commit: "Ran git commit",
    edit_file: "Edited file",
    write_file: "Wrote file",
    run_command: "Ran command",
  },
  toolRunning: {
    read_file: "Reading file…",
    list_dir: "Listing folder…",
    glob: "Running glob…",
    grep: "Running grep…",
    get_diagnostics: "Getting diagnostics…",
    git_status: "Running git status…",
    git_diff: "Running git diff…",
    git_log: "Running git log…",
    git_commit: "Running git commit…",
    edit_file: "Editing file…",
    write_file: "Writing file…",
    run_command: "Running command…",
  },
  toolDoneOther: "Ran {tool}",
  toolRunningOther: "Running {tool}…",
  openFile: "Open in editor",
  toolGroup: "{label} · {n}",
  dockRight: "Move to the right side bar",
};
