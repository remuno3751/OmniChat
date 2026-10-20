# モーション / ストリーミング表示 / 完了バナー

設定 > 外観に 2 項目を追加(端末設定 `omnichat.device` に保存、サーバーには同期しない)。

| キー | 値 | 既定 | 意味 |
|---|---|---|---|
| `motionAmount` | `off` / `reduced` / `standard` / `rich` | `standard` | UI アニメーションの量。`off` と OS の prefers-reduced-motion は全モーション無効 |
| `streamAnim` | `off` / `smooth` / `particles` | `smooth` | 返信ストリーミングの見せ方。`particles` は Web のみ(ネイティブは `smooth`)。amount が `off` / reduced-motion なら `off` |

## ヘルパー

- `ui/motionLevel.ts`(純関数): `motionFactors(amount, osReduce)` → `{ on, durK, distK, stagger }`(reduced = 時間×0.75・移動×0.7・stagger なし、rich = ×1.25・×1.4)、`resolveStreamAnim()`。
- `theme.ts` `useThemeDef()`: `dur.{fast,base,slow}` はテーマ値に `durK` を掛けた ms(off なら 0)、`mo` に係数、`reduceMotion` は「OS 設定 or off」。
- `ui/skin.tsx`: `Enter`(マウント時のフェード+移動。Simple も rise。`skip` で静止、終了後は transform を外す)、`useOnce`、`usePresence(visible)`(退場アニメ付きマウント管理)、`pressStyle`(押下スケール。Simple は 0.98)、`tx(th)`(Web の CSS transition。hover・選択・トグル用で JS コストなし)。
- `streamReveal.ts`(純関数・テスト `__tests__/streamReveal.test.ts`): `stepReveal(text, shown, dtMs, carry)`。最低 45 文字/秒 + 溜まり分を 280ms の時定数で追いつく。1 ステップ最低 1 文字(停止しない)、100ms を超える dt は丸め、1500 文字超の溜まりは先に表示、サロゲートペアは分割しない。
- `ui/streamText.tsx`: `useStreamText(text, streaming)` が rAF ループ(約 30 コミット/秒)で上記を回す。完了 (`streaming=false`) で即全文。`particles` は直近約 420ms に出た文字(最大 10 チャンク)の直前に私用領域マーカー(U+E000〜)を挿入し、`Markdown.tsx` の `renderInline` が `renderParticles()` でマーカー以降を `<span class="oc-condense">`(opacity+blur+text-shadow で粒が文字に収束)に包む。コードブロック等のマーカーは `stripCodeMarks` で除去。

## 適用箇所

画面切替 (`App.tsx` `Enter key={view}`)、サイドバー(ドロワーは `usePresence` のスライド+フェード、行の新規追加は Enter)、ポップアップ (`kit.tsx` Sheet: 端末で fade+scale/drop、スマホで slide)、ボタン/タブ/セグメント/トグル/メニュー行の押下・hover・選択 (`tx`, `pressStyle`)、新規メッセージ(作成 4 秒以内のみ)、設定ページ切替 (`PageFrame`)。

## 完了バナー (`ui/chatBanner.tsx`)

`notify kind=done` は画面上部のバナーに(以前は入力欄の上のトースト)。開いているチャット(`view==='chat'` の `activeId`)には出さない。最大 3 枚スタック、約 4 秒で自動消去、×で閉じる、タップでそのチャットを開く。`error` / `approval` は従来のトースト。

## 実ブラウザ検証で直した点

- 粒子マーカーが Markdown 構文の途中(`- ` の前、`|---|` の中、`**` の間など)に入ると解析結果が変わり、約 0.4 秒レイアウトが跳ねた。`Markdown.tsx` はマーカー有り/無しで解析結果が同一のときだけマーカーを残し、違えばマーカー無しで描画する。
- モデル選択とツール承認の `Modal` が `animationType` に fade/slide を固定していたため、アニメーション量 Off / OS の reduce-motion でも約 200ms のフェードが残っていた。`th.reduceMotion` で `none` にする。

## Animation amount on Android / clock skew (note)

Android 実機で「標準」では新規メッセージの出現アニメが見えず「リッチ」でだけ見えた。原因は 3 つ。
1. `MessageView` の新規判定が `Date.now() - m.createdAt < 4000` だった。`createdAt` はサーバー時刻、`Date.now()` は端末時刻なので、数秒のずれで全メッセージが「古い」扱いになった。
2. `Enter` の移動量が 8px・scale .985 と小さく、standard / reduced で更に縮むため、見えにくかった。メッセージは `dist={16}` にした。
3. `motionFactors('reduced')` が時間×0.6・移動×0.5 と強すぎた。現在は 0.75 / 0.7(stagger なし)。

判定ルール (`ui/msgFresh.ts`): チャットを開いた後に届き、かつ開いた時点で表示していた全メッセージより新しい(サーバー時刻同士で比較)ものは時計に関係なく新規。それ以外は従来どおり端末時刻で 4 秒以内を見る。`ChatScreen` が `createFreshTracker()` で追跡し、`MessageView` は mount 時に 1 回だけ判定する。
アニメーションを止めるのは「オフ」と OS の reduce-motion だけ。reduced は軽い動きとして残る。
