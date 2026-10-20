// Pure validation for the Settings > Server forms. Returns an i18n key on error, or null when valid.

const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateUsername(s: string): string | null {
  const n = s.trim().length;
  return n >= 3 && n <= 32 ? null : 'admin.err.username';
}

export function validatePassword(s: string): string | null {
  return s.length >= 8 ? null : 'admin.err.password';
}

export function validateServerName(s: string): string | null {
  return s.length <= 60 && !CONTROL.test(s) ? null : 'admin.err.name';
}

export function validateServerDescription(s: string): string | null {
  return s.length <= 280 ? null : 'admin.err.desc';
}
