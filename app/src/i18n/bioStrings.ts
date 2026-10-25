// Desktop biometric unlock strings (CodePage, CodeLockGate). Merged into en.ts / ja.ts (same keys in both).
export const en: Record<string, string> = {
  'codelock.bio': 'Unlock with {kind}',
  'codelock.bio.touchid': 'Touch ID',
  'codelock.bio.hello': 'Windows Hello (fingerprint / face)',
  'codelock.bioHint': 'Asks for it first when Code opens. The PIN always stays available as a fallback.',
  'codelock.bioEnable': 'Confirm to turn on biometric unlock',
  'codelock.bioFailed': 'Biometric check did not succeed. Use the PIN instead.',
  'codelock.bioRetry': 'Try biometrics again',
};

export const ja: Record<string, string> = {
  'codelock.bio': '{kind}で解除する',
  'codelock.bio.touchid': 'Touch ID',
  'codelock.bio.hello': 'Windows Hello(指紋・顔)',
  'codelock.bioHint': 'Code を開くときに、最初にこの認証を求めます。PIN は、いつでも代わりに使えます。',
  'codelock.bioEnable': '生体認証での解除を有効にするため、認証してください',
  'codelock.bioFailed': '生体認証に成功しませんでした。PIN を使ってください。',
  'codelock.bioRetry': 'もう一度、生体認証を試す',
};
