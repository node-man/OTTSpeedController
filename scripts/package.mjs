/* Public extension build; never writes to an existing legacy installation. */
import {cp,mkdir,readFile,rm,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import product from '../shared/product.js';
import {extensionAssets} from '../shared/extension-assets.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {version}=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const dist=join(root,'dist'),output=join(dist,product.name+'-'+version);
await mkdir(dist,{recursive:true});
const resolvedDist=await realpath(dist);
let resolvedOutput;
try{resolvedOutput=await realpath(output);}catch(error){if(error.code!=='ENOENT')throw error;resolvedOutput=resolve(resolvedDist,product.name+'-'+version);}
const within=relative(resolvedDist,resolvedOutput);
if(!within||within.startsWith('..')||isAbsolute(within)||!resolvedOutput.endsWith(product.name+'-'+version))throw new Error('Unsafe package output path.');
await rm(output,{recursive:true,force:true});
for(const file of extensionAssets){await mkdir(dirname(join(output,file)),{recursive:true});await cp(join(root,file),join(output,file),{recursive:true});}
console.log('Unpacked extension: '+output);
console.log('Existing users: update files in the SAME installed directory after translation finishes. Do not load a second path or delete the old extension.');
