import { beforeAll,afterAll,it,expect } from "vitest";
import { generateSql } from "../scripts/build-sql.ts";
import { getEpisode,getTranscriptExcerpt,searchEpisodes,searchTranscripts,ToolInputError } from "../src/tools.ts";
import { D1Shim,d1 } from "./helpers/d1-shim.ts";
import { files,manifest } from "./helpers/fixtures.ts";
let shim:D1Shim;beforeAll(async()=>{shim=new D1Shim();await shim.exec(await generateSql(manifest(),files,{now:"2026-01-02T00:00:00.000Z"}));});afterAll(()=>shim.close());
it("searches transcripts with URLs, guest strings and filters",async()=>{
  const result=await searchTranscripts(d1(shim),{query:"portable memory",limit:8});
  expect(result.results[0]).toMatchObject({episode:77,speaker:"Kimberly Logan",url:files[2].transcript[1].url,guests:["Kimberly Logan"]});
  expect(result.results[0].cite).toContain(result.results[0].url);
  expect((await searchTranscripts(d1(shim),{query:"multi-agent",limit:8,episode:38})).results.every(r=>r.episode===38)).toBe(true);
  expect((await searchTranscripts(d1(shim),{query:"memory database",limit:8})).results.some(r=>r.match==="some_terms")).toBe(true);
  expect((await searchTranscripts(d1(shim),{query:"many words",limit:8})).results[0].snippet.length).toBeLessThanOrEqual(601);
  const missing=await searchTranscripts(d1(shim),{query:"memory",limit:8,episode:999});expect(missing.results).toHaveLength(0);expect(missing.note).toContain("Episode 999");
});
it("searches episodes with folded diacritics and chapters",async()=>{
  const results=(await searchEpisodes(d1(shim),{query:"Griciunas",limit:8})).results;expect(results[0]).toMatchObject({episode:38,guests:["Aurimas Griciūnas (SwirlAI)"],matching_chapters:[]});
  const chapters=(await searchEpisodes(d1(shim),{query:"multi-agent",limit:8})).results.find(r=>r.episode===2)?.matching_chapters;expect(chapters).toEqual([{time:"0:00",label:"Multi-agent teams"}]);
});
it("returns episode metadata and bounded excerpt",async()=>{
  const ep=await getEpisode(d1(shim),{slug:files[0].canonicalUrl});expect(ep).toMatchObject({episode:2,duration:"37:39",guests:[{name:"João Moura",company:"CrewAI"}]});
  expect((await getEpisode(d1(shim),{slug:`https://chainofthought.show/podcast/${files[0].slug}.json`})).episode).toBe(2);
  await expect(getEpisode(d1(shim),{episode:2,slug:files[2].slug})).rejects.toThrow(/different episodes/u);
  const excerpt=await getTranscriptExcerpt(d1(shim),{episode:77,at:"0:10",before:1,after:5});expect(excerpt.anchor).toMatchObject({segment_index:1,time:"0:10"});expect(excerpt.segments).toHaveLength(3);expect(excerpt.segments[1].url).toBe(files[2].transcript[1].url);
  expect(excerpt.segments[2].text.length).toBeLessThanOrEqual(1500);expect(excerpt.has_more_before).toBe(false);expect(excerpt.has_more_after).toBe(false);
  const byIndex=await getTranscriptExcerpt(d1(shim),{episode:77,at:"#t-2",before:0,after:0});expect(byIndex.anchor.segment_index).toBe(2);expect(byIndex.has_more_before).toBe(true);expect(byIndex.has_more_after).toBe(false);
  await expect(getTranscriptExcerpt(d1(shim),{episode:77,at:"99",before:2,after:5})).rejects.toBeInstanceOf(ToolInputError);
  await expect(getEpisode(d1(shim),{episode:999})).rejects.toThrow(/No episode 999/u);
});
