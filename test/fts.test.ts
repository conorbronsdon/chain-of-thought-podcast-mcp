import { describe,it,expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildFtsQuery } from "../src/fts.ts";
describe("FTS sanitizer",()=>{
  it("quotes token runs and removes stopwords",()=>{
    expect(buildFtsQuery("multi-agent systems")?.all).toBe('"multi agent" "systems"');
    expect(buildFtsQuery("Qwen's cost")?.all).toBe('"qwen s" "cost"');
    expect(buildFtsQuery("Block MCP rollout 12,000 employees")?.all).toBe('"block" "mcp" "rollout" "12 000" "employees"');
    expect(buildFtsQuery("why multi-agent systems fail")?.all).toBe('"multi agent" "systems" "fail"');
    expect(buildFtsQuery('"exact phrase"')?.all).toBe('"exact" "phrase"');
    expect(buildFtsQuery("AND OR NOT")?.all).toBe('"and" OR "or" OR "not"'.replaceAll(" OR "," "));
  });
  it("never emits an invalid MATCH expression for hostile or fuzzed text",()=>{
    const db=new DatabaseSync(":memory:");db.exec("CREATE VIRTUAL TABLE f USING fts5(text, tokenize='porter unicode61 remove_diacritics 2'); INSERT INTO f(text) VALUES ('multi agent systems'),('database Griciūnas');");
    const check=(input:string)=>{const q=buildFtsQuery(input);if(q){expect(()=>db.prepare("SELECT * FROM f WHERE f MATCH ?").all(q.all)).not.toThrow();expect(()=>db.prepare("SELECT * FROM f WHERE f MATCH ?").all(q.any)).not.toThrow();}};
    for(const s of ['"','*','NEAR(','-',':','AND OR NOT','', '   ','x'.repeat(1000),'title:foo','foo*','^bar','a NEAR/3 b','(x OR y)','\u0000','😀','数据库','العربية','Griciūnas','e\u0301','İstanbul'])check(s);
    const alphabet='" * ( ) : - ^ + { } [ ] , . \' NEAR AND OR NOT abcXYZ09数据库العربية😀';let seed=1234567;
    for(let i=0;i<2200;i++){let s="";const len=(seed%80)+1;for(let j=0;j<len;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+=alphabet[seed%alphabet.length];}check(s);}
    db.close();
  });
});
