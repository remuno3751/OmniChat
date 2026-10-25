// v0.5.6 session C: Pet strings. Merged into en.ts / ja.ts (same keys in both).
const rows: [string, string, string][] = [
  ['pets.say.thinking', 'Thinking…', '考え中…'],
  ['pets.kind.stills', 'Stills', '立ち絵'],
  ['pets.drag.hint', 'Drag the pet by the grip on its top edge, which always works. With "Click through pet" off you can also drag the whole pet. The position is saved on this device.', '上端のつまみ(⋮⋮)でいつでもペットを動かせます。「Pet をクリックスルー」がオフのときは、ペット全体もドラッグできます。位置はこの端末に保存されます。'],
  ['pets.drag.reset', 'Reset position', '位置をリセット'],
  ['pets.create.title', 'Create a pet', 'ペットを作成する'],
  ['pets.create.intro', 'A stills pet is one character drawn in six images, one per state: idle, thinking, working, tool, done and error. The images are stored on your server, so every PC that signs in shows the same pet.', '立ち絵ペットは、1体のキャラクターを6枚の画像で表したものです。状態は idle(待機)、thinking(考え中)、working(生成中)、tool(ツール実行)、done(完了)、error(エラー)の6つ。画像はサーバーに保存され、ログインしたすべての端末で同じペットが表示されます。'],
  ['pets.create.spec', 'Each image: PNG or WebP with a transparent background, square 512 × 512 px, the character centered with about a 10% margin, at most 600 KB. Use the same character, style and colors in all six. idle.png is required.', '画像の条件: 背景透過の PNG または WebP、正方形 512 × 512 px、キャラクターは中央に約10%の余白、1枚 600 KB 以下。6枚とも同じキャラクター・画風・色にしてください。idle.png は必須です。'],
  ['pets.create.copy', 'Copy prompt', 'プロンプトをコピー'],
  ['pets.create.copied', 'Prompt copied', 'プロンプトをコピーしました'],
  ['pets.create.copyFailed', 'Could not copy the prompt', 'プロンプトをコピーできませんでした'],
  ['pets.create.importTitle', 'Import images', '画像を読み込む'],
  ['pets.create.importHint', 'Make the six images with Claude or a GPT image model, then choose them here. Name the files idle.png, thinking.png, working.png, tool.png, done.png and error.png. Large images are scaled down to 512 px and saved as WebP.', 'Claude や GPT の画像生成で6枚を作り、ここで選んでください。ファイル名は idle.png, thinking.png, working.png, tool.png, done.png, error.png にしてください。大きい画像は 512 px に縮小し、WebP にします。'],
  ['pets.create.import', 'Choose images', '画像を選ぶ'],
  ['pets.create.reading', 'Optimizing images…', '画像を最適化しています…'],
  ['pets.create.found', 'Images: {list}', '読み込んだ画像: {list}'],
  ['pets.create.name', 'Pet name', 'ペットの名前'],
  ['pets.create.namePlaceholder', 'My pet', '例: マイペット'],
  ['pets.create.create', 'Create pet', 'ペットを作成'],
  ['pets.create.created', 'Created "{name}"', '「{name}」を作成しました'],
  ['pets.create.createFailed', 'Could not create the pet', 'ペットを作成できませんでした'],
  ['pets.create.importFailed', 'Could not import the images', '画像を読み込めませんでした'],
  ['pets.create.needName', 'Enter a pet name.', 'ペットの名前を入力してください。'],
  ['pets.create.needIdle', 'idle.png is required.', 'idle.png は必須です。'],
  ['pets.create.tooMany', 'Choose up to 6 images.', '画像は6枚までです。'],
  ['pets.create.unmatched', 'These file names are not states: {names}. Use idle, thinking, working, tool, done or error, as .png or .webp.', '状態名になっていないファイルがあります: {names}。idle, thinking, working, tool, done, error のいずれかの名前(.png か .webp)にしてください。'],
  ['pets.create.duplicate', 'More than one file for: {names}', '同じ状態のファイルが複数あります: {names}'],
  ['pets.create.tooBig', '"{name}" is still over 600 KB after optimizing.', '「{name}」は最適化後も 600 KB を超えています。'],
  ['pets.create.tooSmall', '"{name}" must be at least 16 px on its short side.', '「{name}」は短い辺が 16 px 以上必要です。'],
];

export const en: Record<string, string> = Object.fromEntries(rows.map(([k, e]) => [k, e]));
export const ja: Record<string, string> = Object.fromEntries(rows.map(([k, , j]) => [k, j]));
