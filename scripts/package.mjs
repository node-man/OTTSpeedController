/* Creates an unpacked extension directory from an explicit public file allowlist. */
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const output = join(root, 'dist', `OTTSpeed-${version}`);
const files = [
  'manifest.json', 'icons',
  'scripts/background.js', 'scripts/content.js',
  'popup/popup.html', 'popup/popup.css', 'popup/popup.js',
  'subtitles/core.js', 'subtitles/controller.js', 'subtitles/library.js',
  'subtitles/workspace.html', 'subtitles/workspace.css', 'subtitles/workspace.js'
];
await rm(output, { recursive: true, force: true });
for (const file of files) {
  await mkdir(dirname(join(output, file)), { recursive: true });
  await cp(join(root, file), join(output, file), { recursive: true });
}
console.log(`Unpacked extension: ${output}`);
console.log('Chrome → chrome://extensions → Developer mode → Load unpacked → this directory');
