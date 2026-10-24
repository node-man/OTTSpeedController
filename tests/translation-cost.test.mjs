import assert from 'node:assert/strict';
import {apiEquivalent} from '../scripts/translation-cost.mjs';
const result=apiEquivalent({input_tokens:60000,input_tokens_details:{cached_tokens:10000,cache_write_tokens:0},output_tokens:40000,output_tokens_details:{reasoning_tokens:12000}});
assert.equal(result.usd.total,2.51);assert.equal(result.tokens.visibleOutput,28000);
assert.equal(result.usd.outputIncludingReasoning,2); // No second charge for reasoning.
assert.equal(result.withoutCacheUsd.total,2.6);
assert.equal(result.actualBilling.planOrCreditsDebitUsd,null);
for(const usage of [{input_tokens:300000,output_tokens:1},{input_tokens:2,output_tokens:1,input_tokens_details:{cached_tokens:3}},{input_tokens:2,output_tokens:1,input_tokens_details:{cache_write_tokens:1}}])assert.throws(()=>apiEquivalent(usage));
console.log('PASS measured-token API equivalent with cached input, reasoning included once, and unknown billing / unsupported pricing rejected');
