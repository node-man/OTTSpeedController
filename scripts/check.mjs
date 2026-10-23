import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.manifest_version, 3);
for (const directory of ['scripts', 'subtitles', 'popup', 'tests']) {
  async function check(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isDirectory()) await check(file);
      else if (/\.[cm]?js$/.test(item.name)) {
        const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
    }
  }
  await check(join(root, directory));
}
const files = [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap(entry => entry.js), ...Object.values(manifest.icons)];
for (const file of files) assert.ok((await stat(join(root, file))).isFile(), `Missing runtime file: ${file}`);
for (const file of ['popup/popup.html', 'subtitles/workspace.html']) {
  const html = await readFile(join(root, file), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^(?:https?:|data:)/.test(match[1])) throw new Error(`Unexpected remote runtime asset: ${match[1]}`);
    assert.ok((await stat(resolve(root, dirname(file), match[1]))).isFile());
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `Duplicate id in ${file}`);
}
console.log('PASS syntax, manifest version, packaged asset references and unique DOM IDs');
