import assert from 'node:assert/strict';

// Standard, short-context USD prices, verified against the official page on
// 2026-10-24. These estimate an equivalent API request, not a SIWC plan debit.
export const astraPricing={model:'gpt-6-astra',verifiedDate:'2026-10-24',currency:'USD',perTokens:1_000_000,
  source:'https://developers.openai.com/api/docs/pricing',
  input:10,cachedInput:1,cacheWrite30m:12.5,output:50};

export function apiEquivalent(usage){
  const count=(value,name)=>{assert(Number.isSafeInteger(value)&&value>=0,`Invalid ${name}`);return value;};
  const input=count(usage.input_tokens,'input_tokens'),output=count(usage.output_tokens,'output_tokens');
  const cached=count(usage.input_tokens_details?.cached_tokens??0,'cached_tokens');
  const written=count(usage.input_tokens_details?.cache_write_tokens??0,'cache_write_tokens');
  const reasoning=count(usage.output_tokens_details?.reasoning_tokens??0,'reasoning_tokens');
  assert(cached+written<=input,'Cache input exceeds total input');assert(reasoning<=output,'Reasoning exceeds output');
  // This run deliberately stays below the long-context boundary. Do not silently
  // quote short-context prices for another workload or unknown cache retention.
  assert(input<=272000,'Long-context pricing requires a separate calculation');
  assert.equal(written,0,'Nonzero cache writes require verified cache-retention pricing');
  const uncached=input-cached-written;
  const inputUsd=uncached*astraPricing.input/1e6,cachedUsd=cached*astraPricing.cachedInput/1e6,outputUsd=output*astraPricing.output/1e6;
  return {kind:'equivalent-standard-api-cost',pricing:astraPricing,
    tokens:{input,uncachedInput:uncached,cachedInput:cached,cacheWrite:written,output,reasoning,visibleOutput:output-reasoning,total:input+output},
    usd:{input:inputUsd,cachedInput:cachedUsd,outputIncludingReasoning:outputUsd,total:inputUsd+cachedUsd+outputUsd},
    withoutCacheUsd:{input:input*astraPricing.input/1e6,outputIncludingReasoning:outputUsd,total:input*astraPricing.input/1e6+outputUsd,
      note:'Hypothetical same-token request without cache reads; future requests may have different token counts.'},
    actualBilling:{route:'ChatGPT plan usage through SIWC OAuth',apiKeyUsed:false,planOrCreditsDebitUsd:null,
      note:'API-equivalent estimate only. The inference response does not report the actual subscription/credit debit. Reasoning is already included in output tokens.'}};
}
