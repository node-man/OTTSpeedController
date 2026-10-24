/* Imports an already audited capture, not old subtitle/translation inputs. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TranslationStore } from './translation-bridge-store.mjs';
const [input,directory='private-subtitles/bridge']=process.argv.slice(2);
if(!input)throw new Error('Usage: node scripts/translation-bridge-seed.mjs AUDITED_CAPTURE_JSON [PRIVATE_BRIDGE_DIRECTORY]');
const capture=JSON.parse(await readFile(input,'utf8'));
assert.equal(capture.kind,'ottspeed.netflix-capture');assert.equal(capture.schemaVersion,1);
assert.equal(capture.mediaKey,capture.media.key);
const store=await new TranslationStore(resolve(directory)).init();
console.log(JSON.stringify(await store.create({media:capture.media,source:capture.track}),null,2));
