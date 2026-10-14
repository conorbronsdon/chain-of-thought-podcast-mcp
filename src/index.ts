import { createMcpHandler } from "agents/mcp/server";
import { localhostAllowedHostnames, localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createServer } from "./server.ts";
import { runRefresh } from "./refresh.ts";
const list=(s:string):string[]=>s.split(",").map(x=>x.trim()).filter(Boolean);
export function mcpHandler(request:Request,env:Env){
  const host=new URL(request.url).hostname,local=localhostAllowedHostnames().includes(host),workers=host.endsWith(".workers.dev");
  return createMcpHandler(()=>createServer(env),{
    route:"/mcp",
    ...(!local&&!workers?{allowedHostnames:list(env.MCP_HOSTNAMES)}:{}),
    allowedOriginHostnames:[...localhostAllowedOrigins(),...list(env.MCP_ORIGIN_HOSTNAMES),...(workers?[host]:[])],
    onerror:error=>console.error(JSON.stringify({event:"mcp_handler_error",message:error.message}))
  });
}
const plain={"content-type":"text/plain; charset=utf-8"};
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    try{
      const url=new URL(request.url);
      if(url.pathname==="/"&&(request.method==="GET"||request.method==="HEAD"))return new Response(request.method==="HEAD"?null:["Chain of Thought podcast archive","Read-only MCP server for searching and citing the Chain of Thought podcast archive, hosted by Conor Bronsdon.",`Endpoint: ${url.origin}/mcp (Streamable HTTP)`,"Tools: search_transcripts, search_episodes, get_episode, get_transcript_excerpt","Podcast: https://chainofthought.show","README: https://github.com/conorbronsdon/chain-of-thought-podcast-mcp#readme","Cite the episode pages on chainofthought.show, not this server."].join("\n"),{headers:plain});
      if(url.pathname==="/health"&&request.method==="GET")return new Response("ok",{headers:plain});
      if(url.pathname==="/mcp")return mcpHandler(request,env)(request,env,ctx);
      return new Response("Not found",{status:404,headers:plain});
    }catch(error){console.error(JSON.stringify({event:"router_error",message:error instanceof Error?error.message:String(error)}));return new Response("Internal server error",{status:500,headers:plain});}
  },
  scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):void{
    if(env.REFRESH_ENABLED!=="true"){console.log(JSON.stringify({event:"refresh",action:"skipped",reason:"disabled"}));return;}
    ctx.waitUntil(runRefresh({db:env.DB,fetch,now:new Date(),baseUrl:env.CORPUS_BASE_URL}).then(result=>{console.log(JSON.stringify({event:"refresh",...result}));}).catch(error=>{console.error(JSON.stringify({event:"refresh",action:"error",message:error instanceof Error?error.message:String(error)}));}));
  }
} satisfies ExportedHandler<Env>;
