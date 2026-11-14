// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the tarball contains only dist/, README, LICENSE and package.json', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const [info] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }));
  const files = info.files.map((/** @type {{ path: string }} */ f) => f.path).sort();
  for (const f of files) {
    assert.match(f, /^(dist\/[a-z]+\.(js|d\.ts)|README\.md|LICENSE|package\.json)$/, `unexpected file in tarball: ${f}`);
  }
  assert.ok(files.includes('dist/index.js'));
  assert.ok(files.includes('dist/index.d.ts'));
  assert.ok(files.includes('LICENSE'));
});

test('no runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});

test('metadata uses one name, author, URL and license', () => {
  assert.equal(pkg.name, '@arkenforge/core');
  assert.equal(pkg.author, 'ArkenForge');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.repository.url, 'git+https://github.com/arkenforge/arken-core.git');
});
