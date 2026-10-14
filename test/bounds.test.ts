import { it,expect } from "vitest";
import { searchTranscriptsSchema,getExcerptSchema } from "../src/server.ts";
import { mcpHandler } from "../src/index.ts";
import worker from "../src/index.ts";
import { D1Shim,d1 } from "./helpers/d1-shim.ts";
import { SCHEMA } from "../src/schema.ts";
it("rejects out-of-range input and applies defaults",()=>{
  for(const limit of [0,21,1.5])expect(searchTranscriptsSchema.safeParse({query:"x",limit}).success).toBe(false);
  expect(searchTranscriptsSchema.safeParse({query:"x".repeat(201)}).success).toBe(false);
  expect(getExcerptSchema.safeParse({episode:2,before:6}).success).toBe(false);
  expect(getExcerptSchema.safeParse({episode:2,after:11}).success).toBe(false);
  expect(getExcerptSchema.safeParse({episode:0}).success).toBe(false);
  expect(searchTranscriptsSchema.parse({query:"word"}).limit).toBe(8);
  expect(getExcerptSchema.parse({episode:2})).toMatchObject({before:2,after:5});
});
it("rejects a long query through the installed MCP handler",async()=>{
  const shim=new D1Shim();await shim.exec(SCHEMA);
  const env:Env={DB:d1(shim),CORPUS_BASE_URL:"https://chainofthought.show",REFRESH_ENABLED:"false",MCP_HOSTNAMES:"",MCP_ORIGIN_HOSTNAMES:""};
  const ctx:ExecutionContext={waitUntil(){},passThroughOnException(){}};
  const request=new Request("http://localhost/mcp",{method:"POST",headers:{host:"localhost","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-06-18"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"search_transcripts",arguments:{query:"x".repeat(201)}}})});
  const response=await mcpHandler(request,env)(request,env,ctx);const text=await response.text();
  expect(response.status).not.toBe(500);expect(text).toMatch(/isError|"error"/u);shim.close();
});
it("lists the annotated tools and serves health without a database query",async()=>{
  const shim=new D1Shim();await shim.exec(SCHEMA);
  const env:Env={DB:d1(shim),CORPUS_BASE_URL:"https://chainofthought.show",REFRESH_ENABLED:"false",MCP_HOSTNAMES:"",MCP_ORIGIN_HOSTNAMES:""};
  const ctx:ExecutionContext={waitUntil(){},passThroughOnException(){}};
  expect(await (await worker.fetch(new Request("http://localhost/health"),env,ctx)).text()).toBe("ok");
  const request=new Request("http://localhost/mcp",{method:"POST",headers:{host:"localhost","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-06-18"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})});
  const response=await mcpHandler(request,env)(request,env,ctx);const text=await response.text();const json=text.startsWith("event:")?text.split("\n").find(line=>line.startsWith("data: "))?.slice(6)??"":text;
  const body=JSON.parse(json) as {result:{tools:{annotations:Record<string,boolean>}[]}};
  expect(body.result.tools).toHaveLength(4);
  for(const tool of body.result.tools)expect(tool.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  shim.close();
});
