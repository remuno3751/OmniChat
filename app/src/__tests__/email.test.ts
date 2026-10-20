// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/email.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEml, buildMailto, emailAll, emailPlaceholders, parseEmail, serializeEmail } from '../email';

const base = { to: '', cc: '', bcc: '', subject: '', body: '', hasHeaders: true };

test('parseEmail reads To, Cc, Bcc, Subject and the body after a blank line', () => {
  const e = parseEmail('To: a@example.com\nCc: b@example.com\nBcc: c@example.com\nSubject: Hello\n\nLine 1\nLine 2');
  assert.deepEqual(e, {
    to: 'a@example.com',
    cc: 'b@example.com',
    bcc: 'c@example.com',
    subject: 'Hello',
    body: 'Line 1\nLine 2',
    hasHeaders: true,
  });
});

test('header names are case-insensitive and accept a full-width colon', () => {
  const e = parseEmail('to：a@example.com\nSUBJECT : Hi\n\nBody');
  assert.equal(e.to, 'a@example.com');
  assert.equal(e.subject, 'Hi');
  assert.equal(e.body, 'Body');
});

test('Japanese subject and Japanese labels', () => {
  const e = parseEmail('宛先: 山田 <yamada@example.com>\n件名: 御見積書のご送付\n\n本文です。');
  assert.equal(e.to, '山田 <yamada@example.com>');
  assert.equal(e.subject, '御見積書のご送付');
  assert.equal(e.body, '本文です。');
  assert.equal(e.hasHeaders, true);
});

test('continuation lines are appended to the previous header', () => {
  const e = parseEmail('Subject: A very long\n subject line\nTo: a@example.com,\n\tb@example.com\n\nBody');
  assert.equal(e.subject, 'A very long subject line');
  assert.equal(e.to, 'a@example.com, b@example.com');
  assert.equal(e.body, 'Body');
});

test('no recognised header at the start means the whole content is body', () => {
  const content = 'Just some text\nSubject: not a header here';
  const e = parseEmail(content);
  assert.equal(e.hasHeaders, false);
  assert.equal(e.body, content);
  assert.equal(e.subject, '');
});

test('leading blank line means no headers', () => {
  const content = '\nTo: a@example.com\n\nBody';
  const e = parseEmail(content);
  assert.equal(e.hasHeaders, false);
  assert.equal(e.body, content);
});

test('header block without a blank line: the next line starts the body', () => {
  const e = parseEmail('Subject: Hi\nDear all,\nThanks');
  assert.equal(e.subject, 'Hi');
  assert.equal(e.body, 'Dear all,\nThanks');
  assert.equal(e.hasHeaders, true);
});

test('header block with no body', () => {
  const e = parseEmail('To: a@example.com\nSubject: Only headers');
  assert.equal(e.body, '');
  assert.equal(e.subject, 'Only headers');
});

test('a blank line right after the headers keeps the body intact, including its own blank lines', () => {
  const e = parseEmail('Subject: S\n\n\nSecond paragraph');
  assert.equal(e.body, '\nSecond paragraph');
});

test('CRLF input is normalised', () => {
  const e = parseEmail('To: a@example.com\r\nSubject: S\r\n\r\nLine A\r\nLine B');
  assert.equal(e.subject, 'S');
  assert.equal(e.body, 'Line A\nLine B');
});

test('serialize then parse round-trips', () => {
  const e = {
    to: 'a@example.com, b@example.com',
    cc: 'c@example.com',
    bcc: 'd@example.com',
    subject: '件名 with ASCII too',
    body: '本文\n\n二段落目',
    hasHeaders: true,
  };
  assert.deepEqual(parseEmail(serializeEmail(e)), e);
  assert.equal(emailAll(e), serializeEmail(e));
});

test('serialize omits empty headers and keeps one blank line before the body', () => {
  assert.equal(serializeEmail({ ...base, subject: 'S', body: 'B' }), 'Subject: S\n\nB');
  assert.equal(serializeEmail({ ...base, to: 'x@example.com', body: '' }), 'To: x@example.com\n\n');
});

test('serialize with no headers returns the body unchanged', () => {
  const e = { ...base, body: 'Only body\nSubject: looks like a header' };
  assert.equal(serializeEmail(e), e.body);
  assert.deepEqual(parseEmail(serializeEmail(e)).body, e.body);
});

test('buildMailto encodes Japanese, newlines and ampersands', () => {
  const { url, truncated } = buildMailto({ ...base, to: 'a@example.com', subject: '件名 & 更新', body: '一行目\n二行目 & 三' });
  assert.equal(truncated, false);
  assert.equal(
    url,
    'mailto:a%40example.com?subject=' +
      encodeURIComponent('件名 & 更新') +
      '&body=' +
      encodeURIComponent('一行目\r\n二行目 & 三'),
  );
  assert.ok(url.includes('%0D%0A'));
  assert.ok(url.includes('%26'));
});

test('buildMailto omits empty fields', () => {
  assert.equal(buildMailto({ ...base, subject: 'S' }).url, 'mailto:?subject=S');
  assert.equal(buildMailto({ ...base, to: 'a@example.com', cc: 'c@example.com' }).url, 'mailto:a%40example.com?cc=c%40example.com');
  assert.equal(buildMailto({ ...base, to: 'a@example.com' }).url, 'mailto:a%40example.com');
  assert.equal(buildMailto({ ...base }).url, 'mailto:');
});

test('buildMailto includes cc, bcc, subject, body in that order', () => {
  const { url } = buildMailto({ to: 'a@x.com', cc: 'c@x.com', bcc: 'b@x.com', subject: 'S', body: 'B', hasHeaders: true });
  assert.equal(url, 'mailto:a%40x.com?cc=c%40x.com&bcc=b%40x.com&subject=S&body=B');
});

test('buildMailto shortens a long body at a code-point boundary and sets truncated', () => {
  const body = 'これは長い本文です。'.repeat(400) + '😀'.repeat(50);
  const { url, truncated } = buildMailto({ ...base, to: 'a@example.com', subject: 'S', body }, 1800);
  assert.equal(truncated, true);
  assert.ok(url.length <= 1800, `length ${url.length}`);
  // no broken %-escape at the end, and the body decodes cleanly
  assert.doesNotThrow(() => decodeURIComponent(url));
  assert.equal(/%[0-9A-Fa-f]?$/.test(url), false);
  const bodyPart = decodeURIComponent(url.slice(url.indexOf('&body=') + 6));
  assert.ok(body.replace(/\r\n/g, '\n').startsWith(bodyPart.replace(/\r\n/g, '\n')));
  assert.ok(bodyPart.length > 0);
});

test('buildMailto never splits a surrogate pair at the cut', () => {
  for (let n = 1; n < 60; n++) {
    const body = 'a'.repeat(n) + '😀'.repeat(200);
    const { url } = buildMailto({ ...base, to: 'a@example.com', body }, 200);
    assert.ok(url.length <= 200 || url.indexOf('&body=') < 0, `len ${url.length}`);
    assert.doesNotThrow(() => decodeURIComponent(url));
    assert.equal(/%[0-9A-Fa-f]?$/.test(url), false);
  }
});

test('buildMailto keeps a lone surrogate from throwing', () => {
  const { url } = buildMailto({ ...base, body: 'ok \uD83D end' });
  assert.doesNotThrow(() => decodeURIComponent(url));
  assert.ok(url.includes(encodeURIComponent('�')));
});

test('buildMailto is not truncated when the body fits', () => {
  const r = buildMailto({ ...base, body: 'short' }, 1800);
  assert.deepEqual(r, { url: 'mailto:?body=short', truncated: false });
});

function headerValue(eml, name) {
  // RFC 5322 unfolding: drop the CRLF, keep the leading whitespace of the continuation
  const unfolded = eml.replace(/\r\n(?=[ \t])/g, '');
  const line = unfolded.split('\r\n').find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'));
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
}

test('buildEml uses CRLF only', () => {
  const eml = buildEml({ ...base, to: 'a@example.com', subject: '件名', body: 'x\ny\r\nz' }, new Date('2026-10-17T10:00:00Z'));
  assert.equal(/(^|[^\r])\n/.test(eml), false, 'bare LF found');
  assert.ok(eml.includes('\r\n\r\n'));
});

test('buildEml writes the Date in RFC 5322 UTC form', () => {
  const eml = buildEml({ ...base, body: 'b' }, new Date('2026-10-17T10:00:00Z'));
  assert.equal(headerValue(eml, 'Date'), 'Sat, 17 Oct 2026 10:00:00 +0000');
  const eml2 = buildEml({ ...base, body: 'b' }, new Date('2026-01-05T08:03:09Z'));
  assert.equal(headerValue(eml2, 'Date'), 'Mon, 05 Jan 2026 08:03:09 +0000');
});

test('buildEml header set: To, Cc, Bcc omitted when empty; MIME headers present', () => {
  const eml = buildEml({ ...base, to: 'a@example.com', subject: 'Hi', body: 'b' }, new Date(0));
  assert.equal(headerValue(eml, 'To'), 'a@example.com');
  assert.equal(headerValue(eml, 'Cc'), undefined);
  assert.equal(headerValue(eml, 'Bcc'), undefined);
  assert.equal(headerValue(eml, 'Subject'), 'Hi');
  assert.equal(headerValue(eml, 'MIME-Version'), '1.0');
  assert.equal(headerValue(eml, 'Content-Type'), 'text/plain; charset=UTF-8');
  assert.equal(headerValue(eml, 'Content-Transfer-Encoding'), 'base64');
  assert.equal(headerValue(eml, 'X-Unsent'), '1');
});

test('buildEml includes Cc and Bcc when set', () => {
  const eml = buildEml({ ...base, cc: 'c@example.com', bcc: 'd@example.com', body: 'b' }, new Date(0));
  assert.equal(headerValue(eml, 'Cc'), 'c@example.com');
  assert.equal(headerValue(eml, 'Bcc'), 'd@example.com');
});

test('buildEml base64 body decodes back to the body with CRLF newlines', () => {
  const body = '日本語の本文です。\nLine two 😀\n';
  const eml = buildEml({ ...base, body }, new Date(0));
  const bodyStart = eml.indexOf('\r\n\r\n') + 4;
  const b64 = eml.slice(bodyStart).replace(/\r\n/g, '');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), body.replace(/\n/g, '\r\n'));
});

test('buildEml wraps base64 body lines at 76 columns', () => {
  const eml = buildEml({ ...base, body: 'あ'.repeat(300) }, new Date(0));
  const bodyLines = eml.slice(eml.indexOf('\r\n\r\n') + 4).split('\r\n').filter((l) => l.length > 0);
  assert.ok(bodyLines.length > 1);
  for (const l of bodyLines) assert.ok(l.length <= 76, `line ${l.length}`);
});

test('buildEml encodes a non-ASCII subject as RFC 2047 words that decode back', () => {
  const subject = '御見積書のご送付について（2026年10月分）😀';
  const eml = buildEml({ ...base, subject, body: 'b' }, new Date(0));
  const raw = headerValue(eml, 'Subject');
  const words = raw.split(/\s+(?==\?UTF-8\?B\?)/);
  assert.ok(words.length > 1);
  for (const w of words) {
    assert.ok(w.length <= 75, `encoded word ${w.length}`);
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
  }
  const decoded = words
    .map((w) => Buffer.from(w.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
    .join('');
  assert.equal(decoded, subject);
});

test('buildEml keeps ASCII subjects as is', () => {
  const eml = buildEml({ ...base, subject: 'Quarterly report', body: 'b' }, new Date(0));
  assert.equal(headerValue(eml, 'Subject'), 'Quarterly report');
});

test('buildEml subject encoded words never split a code point', () => {
  const subject = '😀'.repeat(40);
  const eml = buildEml({ ...base, subject, body: 'b' }, new Date(0));
  const raw = headerValue(eml, 'Subject');
  const words = raw.split(/\s+(?==\?UTF-8\?B\?)/);
  const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
  assert.equal(decoded, subject);
  assert.equal(decoded.includes('�'), false);
});

test('emailPlaceholders finds all marker forms', () => {
  const body = '金額は[要確認: 税込か税抜か]です。日付は[要確認：未定]。[TODO: add date] and [CHECK: name] and [todo: lower]';
  assert.deepEqual(emailPlaceholders(body), [
    '[要確認: 税込か税抜か]',
    '[要確認：未定]',
    '[TODO: add date]',
    '[CHECK: name]',
    '[todo: lower]',
  ]);
});

test('emailPlaceholders ignores other brackets and returns [] when none', () => {
  assert.deepEqual(emailPlaceholders('[note: x] [要確認 no colon] plain'), []);
  assert.deepEqual(emailPlaceholders(''), []);
});
