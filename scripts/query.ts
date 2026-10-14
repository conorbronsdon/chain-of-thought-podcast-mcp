import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const args=process.argv.slice(2);const take=(flag:string)=>{const i=args.indexOf(flag);if(i<0)return undefined;const value=args[i+1];args.splice(i,2);return value;};
const url=take("--url")??"http://127.0.0.1:8787/mcp",top=Number(take("--top")??"8"),compact=args.includes("--compact");
const rest=args.filter(x=>x!=="--compact");
if(rest.length!==2){console.error("Usage: node scripts/query.ts [--url URL] [--top N --compact] <tool> '<json args>'");process.exit(2);}
const client=new Client({name:"cot-archive-query",version:"0.1.0"},{versionNegotiation:{mode:"auto"}});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const response=await client.callTool({name:rest[0],arguments:JSON.parse(rest[1]) as Record<string,unknown>});
  const content=response.content.find(c=>c.type==="text");let data:Record<string,unknown>|typeof response=response;
  if(content?.type==="text")try{data=JSON.parse(content.text) as Record<string,unknown>;}catch{data={isError:response.isError===true,message:content.text};}
  if(compact&&data&&typeof data==="object"&&"results" in data&&Array.isArray(data.results))for(const r of data.results.slice(0,top) as Record<string,unknown>[])console.log([r.episode,r.episode_title??r.title,r.speaker??"",r.time??"",r.url,String(r.snippet??"").slice(0,160)].join(" | "));
  else console.log(JSON.stringify(data,null,2));
}finally{await client.close();}
