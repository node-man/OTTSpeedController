/* Netflix text asset parsing. No player access, credentials or translation. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OTTNetflixSubtitles = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function parseAsset(text, core, Parser) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > core.limits.maxBytes) throw new Error('자막 파일이 없거나 5 MB를 초과합니다.');
    if (/^\s*(?:\uFEFF)?WEBVTT\b/.test(text)) {
      const parsed = core.parse(text, 'netflix.vtt');
      const inputCount = (text.match(/^.*\d{2}:\d{2}[^\n]*-->[^\n]*$/gm) || []).length;
      return { cues: parsed.cues, format: 'vtt', audit: { inputCount, acceptedCount: parsed.cues.length,
        excludedCount: inputCount - parsed.cues.length, excluded: [], warnings: parsed.warnings,
        documentComplete: text.trim().length > 0, allTimedEntriesAccountedFor: inputCount === parsed.cues.length } };
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('외부 XML 선언을 포함한 자막은 수집하지 않습니다.');
    const doc = new Parser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || doc.documentElement?.localName !== 'tt' || !/<\/(?:[\w-]+:)?tt\s*>\s*$/.test(text)) throw new Error('완전한 TTML 문서가 아닙니다.');
    const tt = doc.documentElement;
    const param = name => tt.getAttributeNS('http://www.w3.org/ns/ttml#parameter', name) || tt.getAttribute('ttp:' + name);
    let frameRate = Number(param('frameRate') || 30);
    const multiplier = param('frameRateMultiplier');
    if (multiplier) { const [n,d] = multiplier.split(/\s+/).map(Number); frameRate *= n/d; }
    const tickRate = Number(param('tickRate') || (param('frameRate') ? frameRate * Number(param('subFrameRate') || 1) : 1));
    function time(value) {
      if (!value) return NaN;
      let m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
      if (m) return Math.round((Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number('0.'+(m[4]||'0')))*1000);
      m = /^(\d+):(\d{2}):(\d{2}):(\d+)$/.exec(value);
      if (m) return Math.round((Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/frameRate)*1000);
      m = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(value);
      return m ? Math.round(Number(m[1]) * ({h:3600000,m:60000,s:1000,ms:1,f:1000/frameRate,t:1000/tickRate}[m[2]])) : NaN;
    }
    function plain(node) {
      if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue;
      if (node.localName === 'br') return '\n';
      return Array.from(node.childNodes || []).map(plain).join('');
    }
    const entries = Array.from(doc.getElementsByTagNameNS('*','p'));
    const cues = [], excluded = [], ids = new Set();
    for (const [i,p] of entries.entries()) {
      const originalId = p.getAttribute('xml:id') || p.getAttribute('id');
      const id = originalId || `netflix-p-${i+1}`;
      const content = plain(p).replace(/[\t ]+/g,' ').split('\n').map(s=>s.trim()).join('\n').trim();
      if (!content) { excluded.push({ id, reason: 'empty-text', harmless: !p.getAttribute('smpte:backgroundImage') && !p.getAttribute('backgroundImage') }); continue; }
      let ancestor = p.parentNode, relativeContainer = false;
      while (ancestor?.nodeType === 1 && ancestor !== tt) {
        if (ancestor.getAttribute('begin') || ancestor.getAttribute('end') || ancestor.getAttribute('dur')) relativeContainer = true;
        ancestor = ancestor.parentNode;
      }
      const startMs = time(p.getAttribute('begin'));
      const endMs = p.getAttribute('end') ? time(p.getAttribute('end')) : startMs + time(p.getAttribute('dur'));
      if (relativeContainer || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || ids.has(id)) {
        excluded.push({ id, reason: relativeContainer ? 'unsupported-container-time' : ids.has(id) ? 'duplicate-id' : 'invalid-time', harmless:false }); continue;
      }
      ids.add(id); cues.push({id,startMs,endMs,text:content});
    }
    // Do not silently sort, merge or change overlapping source captions.
    if (cues.length) core.serializeVtt(cues);
    return {cues,format:'ttml',audit:{inputCount:entries.length,acceptedCount:cues.length,excludedCount:excluded.length,excluded,
      documentComplete:true,allTimedEntriesAccountedFor:entries.length===cues.length+excluded.length && excluded.every(e=>e.harmless),warnings:[]}};
  }
  return Object.freeze({parseAsset});
});
