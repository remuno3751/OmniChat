// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('DshIntegration shows the tgz name of the current dsh-plugin version', () => {
  const ver = JSON.parse(fs.readFileSync(new URL('../../../dsh-plugin/package.json', import.meta.url), 'utf8')).version;
  const src = fs.readFileSync(new URL('../components/DshIntegration.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes(`omnichat-dsh-bridge-${ver}.tgz`), `update TGZ in DshIntegration.tsx to ${ver}`);
});
