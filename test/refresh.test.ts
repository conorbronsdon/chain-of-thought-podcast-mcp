import { it,expect } from "vitest";
import { SCHEMA } from "../src/schema.ts";
import { runRefresh } from "../src/refresh.ts";
import { searchTranscripts } from "../src/tools.ts";
import { generateSql } from "../scripts/build-sql.ts";
import { D1Shim,d1 } from "./helpers/d1-shim.ts";
import { files,manifest } from "./helpers/fixtures.ts";
import type { EpisodeFile,Manifest } from "../src/types.ts";
const now=new Date("2026-01-03T00:00:00.000Z"),baseUrl="https://chainofthought.show";
function fake(m:Manifest,episodes:EpisodeFile[],status:Record<number,number>={},etag='"v1"'):typeof fetch {
  return (async(input:RequestInfo|URL)=>{
    const url=String(input);if(url.endsWith("/corpus.json"))return Response.json(m);
    const f=episodes.find(e=>url.endsWith(`/${e.slug}.json`));if(!f)return new Response("missing",{status:404});
    if(status[f.episode]===304)return new Response(null,{status:304});
    if(status[f.episode])return new Response("failed",{status:status[f.episode]});
    return Response.json(f,{headers:{etag}});
  }) as typeof fetch;
}
it("ingests one new episode per run, highest first, with searchable FTS",async()=>{
  const shim=new D1Shim();await shim.exec(SCHEMA);const m=manifest();
  expect(await runRefresh({db:d1(shim),fetch:fake(m,files),now,baseUrl})).toMatchObject({action:"ingested",episode:77});expect(shim.batchCount).toBeLessThan(15);
  expect(await runRefresh({db:d1(shim),fetch:fake(m,files),now,baseUrl})).toMatchObject({action:"ingested",episode:38});
  expect((await searchTranscripts(d1(shim),{query:"portable memory",limit:8})).results[0].episode).toBe(77);
  shim.close();
});
it("reingests changed manifest and content, removing stale FTS tokens",async()=>{
  const shim=new D1Shim();await shim.exec(await generateSql(manifest(),files,{now:"2026-01-01T00:00:00.000Z"}));
  const changed=structuredClone(files);changed[2].title="Changed Walrus title";changed[2].transcript[0].text="Novel quantum giraffe phrase.";
  const m=manifest(changed);expect(await runRefresh({db:d1(shim),fetch:fake(m,changed),now,baseUrl})).toMatchObject({action:"ingested",episode:77,reason:"manifest_changed"});
  expect((await searchTranscripts(d1(shim),{query:"quantum giraffe",limit:8})).results).toHaveLength(1);
  expect((await searchTranscripts(d1(shim),{query:"between models",limit:8})).results).toHaveLength(0);
  const content=structuredClone(changed);content[0].transcript[0].text="Novel purple zebra phrase";
  expect(await runRefresh({db:d1(shim),fetch:fake(m,content),now:new Date("2026-01-04T00:00:00.000Z"),baseUrl})).toMatchObject({action:"ingested",episode:2,reason:"content_changed"});
  shim.close();
});
it("handles 304 and rejects incomplete manifests for deletion",async()=>{
  const shim=new D1Shim();await shim.exec(await generateSql(manifest(),files,{now:"2026-01-01T00:00:00.000Z",etags:{[files[0].slug]:'"v1"'}}));
  expect(await runRefresh({db:d1(shim),fetch:fake(manifest(),files,{2:304}),now,baseUrl})).toMatchObject({action:"checked",episode:2,reason:"not_modified"});
  const incomplete=manifest(files.slice(1));const result=await runRefresh({db:d1(shim),fetch:fake(incomplete,files),now:new Date("2026-01-04T00:00:00.000Z"),baseUrl});expect(result.action).not.toBe("deleted");
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get()).toMatchObject({n:3});shim.close();
});
it("backs off a failed episode and moves to another; manifest failure does not change episode rows",async()=>{
  const shim=new D1Shim();await shim.exec(SCHEMA);const m=manifest();
  expect(await runRefresh({db:d1(shim),fetch:fake(m,files,{77:500}),now,baseUrl})).toMatchObject({action:"error",episode:77});
  expect(await runRefresh({db:d1(shim),fetch:fake(m,files),now:new Date("2026-01-03T01:00:00.000Z"),baseUrl})).toMatchObject({action:"ingested",episode:38});
  const bad=async()=>new Response("error",{status:500});expect((await runRefresh({db:d1(shim),fetch:bad as typeof fetch,now,baseUrl})).action).toBe("error");
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get()).toMatchObject({n:1});shim.close();
});
it("deletes one removed episode when at least 90 percent of the manifest remains",async()=>{
  const copies=Array.from({length:10},(_,i)=>{const f=structuredClone(files[0]);const n=i+1;f.episode=n;f.slug=`${n}-copy`;f.canonicalUrl=`https://chainofthought.show/podcast/${f.slug}/`;f.transcript=f.transcript.map(s=>({...s,url:`${f.canonicalUrl}#t-${s.index}`}));return f;});
  const shim=new D1Shim();await shim.exec(await generateSql(manifest(copies),copies,{now:"2026-01-01T00:00:00.000Z"}));
  const reduced=manifest(copies.slice(0,9));expect(await runRefresh({db:d1(shim),fetch:fake(reduced,copies),now,baseUrl})).toMatchObject({action:"deleted",episode:10});
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get()).toMatchObject({n:9});expect(shim.batchCount).toBeLessThan(15);shim.close();
});
