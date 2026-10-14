import { it,expect } from "vitest";
import { canonicalManifestEntry,contentHash,validateEpisodeFile } from "../src/ingest.ts";
import { files,entry } from "./helpers/fixtures.ts";
it("detects changes in canonical manifest and content",async()=>{
  const f=structuredClone(files[0]),e=entry(f);expect(canonicalManifestEntry(e)).toBe(canonicalManifestEntry(structuredClone(e)));
  expect(canonicalManifestEntry({...e,title:"new"})).not.toBe(canonicalManifestEntry(e));expect(canonicalManifestEntry({...e,segmentCount:99})).not.toBe(canonicalManifestEntry(e));
  const original=await contentHash(f);f.usage={arbitrary:"change"};expect(await contentHash(f)).toBe(original);f.transcript[0].text="changed";expect(await contentHash(f)).not.toBe(original);
});
it("rejects invalid segments, URLs and slugs",()=>{
  const f=structuredClone(files[0]);f.transcript[1].index=3;expect(()=>validateEpisodeFile(f)).toThrow(/contiguous/u);
  const g=structuredClone(files[0]);g.transcript[0].url="https://other.test/#t-0";expect(()=>validateEpisodeFile(g)).toThrow(/foreign/u);
  const h=structuredClone(files[0]);h.slug="Bad Slug";expect(()=>validateEpisodeFile(h)).toThrow(/slug/u);
  const missingTime=structuredClone(files[0]);Object.assign(missingTime.transcript[0],{time:null,seconds:null});expect(()=>validateEpisodeFile(missingTime)).toThrow(/invalid fields/u);
});
