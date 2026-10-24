// Original synthetic captions and complete accounting, never a real capture.
import core from '../../subtitles/core.js';
export function collected(id='123',cues=[{id:'one',startMs:1000,endMs:2000,text:'Synthetic first.'},{id:'two',startMs:4000,endMs:5000,text:'Synthetic second.'}]){
  const media=core.mediaIdentity(`https://www.netflix.com/watch/${id}`);
  return {media,source:{name:'synthetic.en.vtt',language:'en',format:'vtt',provenance:'netflix-manifest-resource',sync:{offsetMs:0,scale:1},cues:structuredClone(cues),capture:{mediaKey:media.key,videoId:String(id),fullEpisode:true,coverage:'complete',resourceSha256:'a'.repeat(64),resourceBytes:200,cueCount:cues.length,startMs:Math.min(...cues.map(c=>c.startMs)),endMs:Math.max(...cues.map(c=>c.endMs)),track:{language:'en',profile:'webvtt-lssdh-ios8',segmented:false},audit:{inputCount:cues.length,acceptedCount:cues.length,excludedCount:0,allTimedEntriesAccountedFor:true,documentComplete:true}}}};
}
