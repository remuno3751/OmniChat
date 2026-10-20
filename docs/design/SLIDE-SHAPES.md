# 設計: スライド(pptx)の図形・グラフ・レイアウト

状態: **実装中**(2026-10-19)。

## 問題
AI が作る文書・スライドは、Markdown から変換している(`server/src/docmodel.ts` → `artifacts.ts`)。スライドは「見出し + 文字・箇条書き・表・コード」だけで、**図形(四角、矢印、図解)、グラフ、レイアウトの指定ができない**。

## 方針
Markdown の中に、**スライドの図解を書ける、コードブロックの記法**を足す。`type=pptx` の artifact の中で、見出し(`#` / `##`)が 1 枚のスライドを始め、その下に置いた ` ```shapes ` ブロックが、そのスライドの図形・グラフ・自由配置のテキストになる。ほかのブロック(箇条書きなど)は、従来どおり本文として並ぶ。docx / xlsx への変換と、Markdown として読んだときの見た目は、壊さない。

### 書き方(YAML)
````
## システム構成

- 利用者はアプリからサーバーに接続します

```shapes
body: top
elements:
  - {type: roundRect, id: app, x: 5, y: 40, w: 25, h: 22, fill: "#3b82f6", color: "#ffffff", text: "アプリ"}
  - {type: roundRect, id: srv, x: 38, y: 40, w: 25, h: 22, fill: "#10b981", color: "#ffffff", text: "サーバー"}
  - {type: cylinder, id: db, x: 72, y: 38, w: 22, h: 26, fill: "#f59e0b", text: "DB"}
  - {type: arrow, from: app, to: srv, label: "HTTPS"}
  - {type: arrow, from: srv, to: db}
  - {type: text, x: 5, y: 80, w: 90, h: 10, text: "データはすべて自分のサーバーに保存", size: 14, align: center}
```
````

### ブロックの先頭項目(すべて省略可)
- `bg`: スライドの背景色(`"#rrggbb"`)。
- `body`: 本文(同じスライドの、箇条書きなどの通常のブロック)の置き場所。`top`(上部 30%、既定)/ `left`(左 45%)/ `right`(右 45%)/ `none`(本文を出さない)。図形は絶対座標なので、本文の領域と重ねないのは書き手の責任。
- `notes`: 発表者ノート(文字列)。

### 座標と単位
スライドは 16:9。`x`, `y`, `w`, `h` は、スライド全体に対する**割合(0〜100)**(左上が原点)。タイトルは上部 14% に置かれる。文字サイズ `size` は pt(既定 18)。色は `"#rrggbb"`(3 桁の短縮形も可)か、名前付き(`blue`, `green`, `red`, `orange`, `yellow`, `purple`, `gray`, `black`, `white`)。

### 要素(`elements` の各項目)
共通: `id`(文字列、矢印の接続用、省略可)、`x y w h`、`fill`(塗り。`none` 可)、`line`(枠線の色。`none` 可)、`lineWidth`(pt、既定 1.5)、`text`、`color`(文字色)、`size`、`bold`、`italic`、`align`(left/center/right)、`valign`(top/middle/bottom、既定 middle)、`rotate`(度)、`opacity`(0〜1)。

- 図形 `type`: `rect`, `roundRect`, `ellipse`, `diamond`, `triangle`, `parallelogram`, `hexagon`, `pentagon`, `chevron`, `rightArrow`, `leftArrow`, `upArrow`, `downArrow`, `cylinder`, `star`, `cloud`, `callout`(吹き出し)。
- `line`: `x1 y1 x2 y2`(割合)、`color`、`width`、`dash`(`solid` / `dash` / `dot`)、`head`(`none` / `end` / `both`、既定 none)。
- `arrow`: `from` と `to`(要素の `id`)で 2 つの要素をつなぐ(各要素の、相手に近い辺の中点どうし)。または `x1 y1 x2 y2` で座標指定。矢じりは終点側。`label`(線の中央に出す文字)、`color`、`width`、`dash`。存在しない `id` は、その要素を無視する(ほかは出す)。
- `text`: 図形なしの文字(`type: text`)。
- `chart`: `kind`(`bar` / `column` / `line` / `pie` / `doughnut` / `area`)、`title`、`categories`(文字の配列)、`series`(`[{name, values: [数値…]}]`。`pie` / `doughnut` は 1 系列)。`x y w h`。凡例は系列が 2 つ以上のとき表示。
- `image`: **予約**(添付機能の完成後に `src: "attachment:<id>"` を対応する。今は無視する)。

### 上限と検証(AI の出力は信用しない)
- 1 スライドの要素は最大 60、チャートは最大 4、系列は最大 8、カテゴリは最大 50、文字は 1 要素 500 文字まで。超えた分は捨てる。
- 数値は有限の数だけ。座標は 0〜100 に丸める。知らない `type` や項目は無視。YAML が壊れているときは、そのブロックを**コードブロックとして**本文に残す(エラーで全体を止めない)。
- 色の文字列は、決まった形だけを通す(コードの注入を防ぐ)。

## 出力
- **pptx**(`pptxgenjs`): 図形は `addShape`、文字は `addText`、グラフは `addChart`、矢印は `line` + `endArrowType`。日本語のフォント(既定 `Yu Gothic`/`Meiryo` 相当。今の変換が使っているフォントに合わせる)。
- **docx / xlsx**: `shapes` ブロックは、docx では「(図)」の見出しと、要素の `text` の箇条書き(簡易な代替)にする。xlsx では無視。Markdown の見た目(artifact のプレビュー以外)で、YAML がそのまま見えても、読めるようにしておく。
- **クライアントのプレビュー**(`app/src/components/previews/PptxPreview.tsx`): 同じ座標系で、`react-native-svg`(導入済み)で描く。矢印の接続、チャート(棒・折れ線・円は簡易描画)も含む。pptx と見た目が大きくずれないこと。

## AI への指示
`server/src/prompts.ts` の artifact の説明に、この記法の要約(座標は割合、要素の種類、矢印の `from`/`to`、`body` の置き場所、1 スライドに詰め込みすぎない、図解にはこの記法を使う)を、短く足す。プロンプトの長さを増やしすぎない(30 行以内)。

## 共有コード
`server/src/docmodel.ts` と `app/src/docModel.ts` は、同一のファイルを保つ(`officeSync.test.ts` が検査する)。パーサー(YAML → 検証済みの `Shape` モデル)は、`docmodel.ts` に置き、`yaml` に依存する部分は、各側で `yaml` を使えるか確認する(サーバーは導入済み。アプリに無ければ、**依存を増やさず**、サーバー側でだけ解釈して、クライアントへは解釈済みの JSON を渡す設計にする: artifact の変換 API(`POST /convert` 系)に、`preview: "slides"` の応答を追加し、クライアントは、それを描く)。
