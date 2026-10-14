import type { EpisodeFile,Manifest,ManifestEntry } from "../../src/types.ts";
const make=(episode:number,slug:string,title:string,name:string,company:string|null,texts:string[],chapters:{time:string;seconds:number;label:string}[]):EpisodeFile=>{
  const canonicalUrl=`https://chainofthought.show/podcast/${slug}/`;
  return {schemaVersion:1,episode,slug,season:1,guid:`guid-${episode}`,title,canonicalUrl,publishedAt:"2026-01-01",durationSeconds:2259,guests:[{name,company}],audioUrl:null,transistorUrl:null,youtubeUrl:null,summary:`Summary of ${title}`,chapters,hasTranscript:true,segmentCount:texts.length,transcript:texts.map((text,index)=>({index,time:`0:${String(index*10).padStart(2,"0")}`,seconds:index*10,speaker:index%2?name:"Conor Bronsdon",text,url:`${canonicalUrl}#t-${index}`}))};
};
export const files:EpisodeFile[]=[
  make(2,"2-crew-ai","CrewAI and teams","João Moura","CrewAI",["Multi-agent systems help teams.","Qwen's cost fell for 12,000 employees.","O'Brien built this system."],[{time:"0:00",seconds:0,label:"Multi-agent teams"}]),
  make(38,"38-swirl-ai","SwirlAI data systems","Aurimas Griciūnas","SwirlAI",["Database systems for enterprise search.","We use multi-agent workflows."],[]),
  make(77,"77-walrus","Portable memory with Walrus","Kimberly Logan",null,["Agent memory should move between models.","Portable memory is useful for 12,000 employees.","Memory context " + "many words ".repeat(180)], [{time:"0:00",seconds:0,label:"Portable agent memory"}])
];
export function entry(f:EpisodeFile):ManifestEntry{return {slug:f.slug,episode:f.episode,season:f.season,title:f.title,publishedAt:f.publishedAt,guests:f.guests.map(g=>g.name),canonicalUrl:f.canonicalUrl,json:`https://chainofthought.show/podcast/${f.slug}.json`,hasTranscript:true,segmentCount:f.transcript.length};}
export function manifest(chosen:EpisodeFile[]=files):Manifest{return {schemaVersion:1,dataUpdatedAt:"2026-01-02T00:00:00.000Z",counts:{episodes:chosen.length,segments:chosen.reduce((n,f)=>n+f.transcript.length,0)},episodes:chosen.map(entry)};}
