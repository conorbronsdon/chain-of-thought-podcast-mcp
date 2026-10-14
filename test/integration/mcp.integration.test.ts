import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe,it,expect,beforeAll,afterAll } from "vitest";
import { Client as ModernClient,StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EpisodeFile,Manifest } from "../../src/types.ts";
const url=process.env.MCP_URL??"http://127.0.0.1:8787/mcp";
let modern:ModernClient,legacy:LegacyClient,ep77:EpisodeFile,ep38:EpisodeFile,ep2:EpisodeFile;
async function call(name:string,args:Record<string,unknown>){const r=await modern.callTool({name,arguments:args});const c=r.content.find(x=>x.type==="text");return {error:r.isError===true,value:c?.type==="text"?JSON.parse(c.text) as Record<string,unknown>:null};}
beforeAll(async()=>{
  const m=JSON.parse(await readFile(".cache/corpus/corpus.json","utf8")) as Manifest;
  const file=async(n:number)=>JSON.parse(await readFile(join(".cache/corpus/podcast",`${m.episodes.find(e=>e.episode===n)?.slug}.json`),"utf8")) as EpisodeFile;
  [ep77,ep38,ep2]=await Promise.all([file(77),file(38),file(2)]);
  modern=new ModernClient({name:"cot-integration-modern",version:"1.0.0"},{versionNegotiation:{mode:"auto"}});await modern.connect(new ModernTransport(new URL(url)));
  legacy=new LegacyClient({name:"cot-integration-legacy",version:"1.0.0"});await legacy.connect(new LegacyTransport(new URL(url)));
});
afterAll(async()=>{await modern?.close();await legacy?.close();});
describe("live MCP fixture",()=>{
  it("lists four annotated tools on both clients",async()=>{
    const tools=(await modern.listTools()).tools;expect(tools.map(t=>t.name).sort()).toEqual(["get_episode","get_transcript_excerpt","search_episodes","search_transcripts"]);
    for(const t of tools)expect(t.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
    expect((await legacy.listTools()).tools).toHaveLength(4);
  });
  it("finds real transcript passages and filters by episode",async()=>{
    const target=ep77.transcript[0],query=(target.text.match(/[\p{L}\p{N}\p{Co}]+/gu)??[]).slice(0,6).join("-");
    const search=await call("search_transcripts",{query});expect(search.error).toBe(false);
    expect((search.value?.results as {url:string}[])[0].url).toBe(target.url);
    const episodeTwoQuery=(ep2.transcript[0].text.match(/[\p{L}\p{N}\p{Co}]+/gu)??[]).slice(0,5).join("-");
    const filtered=await call("search_transcripts",{query:episodeTwoQuery,episode:2});expect((filtered.value?.results as {episode:number}[]).length).toBeGreaterThan(0);expect((filtered.value?.results as {episode:number}[]).every(r=>r.episode===2)).toBe(true);
    const old=await legacy.callTool({name:"search_transcripts",arguments:{query:episodeTwoQuery,episode:2}});expect(old.isError).not.toBe(true);
  });
  it("returns real guests, chapters, links and excerpt",async()=>{
    const episode=await call("get_episode",{slug:ep2.canonicalUrl});expect(episode.value).toMatchObject({episode:2,title:ep2.title});
    expect((episode.value?.guests as {name:string;company:string}[]).map(g=>`${g.name} (${g.company})`)).toContain("João Moura (CrewAI)");
    const byNumber=await call("get_episode",{episode:38});expect(byNumber.value).toMatchObject({title:ep38.title,chapters:[]});
    const walrus=await call("get_episode",{episode:77});expect(walrus.value).toMatchObject({title:ep77.title,guests:[{name:"Kimberly Logan",company:"Walrus Protocol"}]});
    const found=await call("search_episodes",{query:"Griciunas"});expect((found.value?.results as {episode:number}[])[0].episode).toBe(38);
    const excerpt=await call("get_transcript_excerpt",{episode:77,at:"0:29"});const expected=[...ep77.transcript].filter(s=>s.seconds<=29).at(-1)??ep77.transcript[0];
    expect(excerpt.value?.anchor).toMatchObject({segment_index:expected.index,time:expected.time});expect(excerpt.value?.url).toBe(expected.url);
    expect((excerpt.value?.segments as {speaker:string;url:string}[]).some(s=>s.url===expected.url&&s.speaker===expected.speaker)).toBe(true);
  });
  it("handles hostile searches and simple HTTP routes",async()=>{
    for(const query of ['"','*','NEAR(','-',':','AND OR NOT','', '数据库','Griciūnas']){const r=await call("search_transcripts",{query});expect(r.value!==null||r.error).toBe(true);}
    try{const long=await call("search_transcripts",{query:"x".repeat(1000)});expect(long.error).toBe(true);}catch(error){expect(String(error)).toMatch(/invalid|length|200|parameter/i);}
    const root=url.replace(/\/mcp$/u,"/");expect(await (await fetch(root)).text()).toContain("chainofthought.show");
    expect(await (await fetch(new URL("/health",url))).text()).toBe("ok");
    expect((await fetch(url)).status).toBe(405);
  });
});
