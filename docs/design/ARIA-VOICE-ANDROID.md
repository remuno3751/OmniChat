# Aria 音声通話: Android(ネイティブ)の音声エンジン

実装: `app/src/voice/voiceEngine.native.ts`。作りは Web 版(`voiceEngine.web.ts`)と同じで、API(`supported` / `createCall` / 型)も同じ。
Web バンドルには入らない(`.native.ts` の拡張子で分かれる)。

## 選んだライブラリ: `react-native-audio-api` 0.13.6(Software Mansion)
- 1つで、(1) マイクのストリーム取り込み(`AudioRecorder.onAudioReady`、16 kHz / モノラル / 320 フレーム)と、(2) 途切れない再生(`AudioContext` / `createBufferSource().start(when)`、`stop()` で割り込み)の両方ができる。
- Web Audio 互換の API なので、Web 版の再生部(`nextTime` での隙間なしの予約、`playing` の集合、`TurnGate`)を、ほぼそのまま移せた。
- Expo の config plugin があり(`app.plugin.js`)、`app.json` の `plugins` だけで設定できる。メンテも活発(2026-10 時点で、ほぼ毎日ビルド)。
- `react-native-worklets` は任意の peer 依存(使わない)。`disableFFmpeg: true` で、不要な FFmpeg を入れない。
- 設定: `iosBackgroundMode` / `androidForegroundService` は切り(通話は前面のみ)、Android の権限は `RECORD_AUDIO` と `MODIFY_AUDIO_SETTINGS`。

## 却下した案
- `@siteed/audio-studio`(旧 `expo-audio-studio`): 録音は良いが、PCM の再生がない(再生に別のライブラリが要る)。録音の入力も `MediaRecorder.AudioSource.MIC` で、`VOICE_COMMUNICATION` ではない。
- `expo-audio-stream`: 最終更新が 2024-09 で止まっている。
- `react-native-live-audio-stream`: 最終更新が 2022-05 で止まっている。録音のみ。
- `expo-audio`: ファイル単位の録音・再生で、ストリームに向かない。

## 既知の制限(重要): エコー除去が効かない
`react-native-audio-api` 0.13.6 の Android の録音(Oboe)は、入力のプリセットを指定しない(既定の Generic)。
`VOICE_COMMUNICATION` で開く設定は、ライブラリにない(`@siteed/audio-studio` も同様)。そのため、端末のエコー除去は、確実には効かない。
対策(今の実装): 返事を再生している間は、マイクの音を送らない(`MUTE_MIC_WHILE_SPEAKING`)。割り込みは、画面の割り込みボタンで行う。
本来の解決: `AndroidAudioRecorder.cpp` の Oboe のビルダーに `setInputPreset(oboe::InputPreset::VoiceCommunication)`(再生側は `setUsage(VoiceCommunication)`)を足す。`patch-package` か、ライブラリのフォークで行える。実機で、エコーの効き具合を見てから決める。

## 未確認(クラウドでは確認できない)
- Android のビルド(`packaging/local/build-android.sh`)、実機のマイク取り込み、再生の途切れ、割り込みの速さ、権限ダイアログ、拒否時の `ready` / `mic-denied`。
- 新アーキテクチャ(RN 0.86)での `react-native-audio-api` のビルド。
- 実機で、取り込みのサンプルレートが 16 kHz でないときは、`downsampleTo16k` で変換する(実装済み、未確認)。
