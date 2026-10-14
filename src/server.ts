import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getEpisode, getTranscriptExcerpt, searchEpisodes, searchTranscripts, ToolInputError } from "./tools.ts";

export const searchTranscriptsSchema=z.object({query:z.string().max(200).describe("Words to find in transcript passages."),limit:z.number().int().min(1).max(20).default(8).describe("Maximum passages, 1 to 20."),episode:z.number().int().min(1).max(9999).optional().describe("Restrict to this episode number.")});
export const searchEpisodesSchema=z.object({query:z.string().max(200).describe("Topic, guest, company, title or chapter words."),limit:z.number().int().min(1).max(20).default(8).describe("Maximum episodes, 1 to 20.")});
export const getEpisodeSchema=z.object({episode:z.number().int().min(1).max(9999).optional().describe("Episode number."),slug:z.string().max(300).optional().describe("Episode slug or full chainofthought.show episode URL.")});
export const getExcerptSchema=z.object({episode:z.number().int().min(1).max(9999).describe("Episode number."),at:z.string().max(20).optional().describe("Segment index, #t-N, t-N, m:ss or h:mm:ss."),before:z.number().int().min(0).max(5).default(2).describe("Segments before the anchor, 0 to 5."),after:z.number().int().min(0).max(10).default(5).describe("Segments after the anchor, 0 to 10.")});
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const instructions="Search and cite the Chain of Thought podcast (https://chainofthought.show), hosted by Conor Bronsdon: long-form interviews with people building AI systems. Use search_transcripts to find what was said, search_episodes to find episodes by topic, guest or company, get_episode for metadata and chapters, and get_transcript_excerpt for the context around a passage. Every result has a url: cite that page. Transcripts are machine-generated (ASR); verify exact quotations against the recording.";
export function createServer(env:Env):McpServer {
  const server=new McpServer({name:"chain-of-thought-podcast",version:"0.1.0"},{instructions});
  const wrap=async(tool:string,run:()=>Promise<unknown>)=>{
    const start=performance.now();let ok=false,results=0;
    try { const value=await run();ok=true; if(value&&typeof value==="object"&&"results" in value&&Array.isArray(value.results))results=value.results.length;else if(value&&typeof value==="object"&&"segments" in value&&Array.isArray(value.segments))results=value.segments.length;else results=1;return {content:[{type:"text" as const,text:JSON.stringify(value)}]}; }
    catch(error){if(!(error instanceof ToolInputError))console.error(JSON.stringify({event:"tool_error",tool,error_type:error instanceof Error?error.name:"unknown"}));return {isError:true,content:[{type:"text" as const,text:error instanceof ToolInputError?error.message:"The archive is temporarily unavailable. Try again shortly."}]};}
    finally{console.log(JSON.stringify({event:"tool",tool,ok,results,ms:Math.round(performance.now()-start)}));}
  };
  server.registerTool("search_transcripts",{title:"Search transcripts",description:"Full-text search over Chain of Thought episode transcripts. Returns ranked passages with episode, guest, speaker, timestamp, a snippet of about 600 characters, and a moment url to cite. At most 20 results. Optional episode filter. Use get_transcript_excerpt for context. Transcripts are machine-generated; verify exact quotes.",inputSchema:searchTranscriptsSchema,annotations},args=>wrap("search_transcripts",()=>searchTranscripts(env.DB,args)));
  server.registerTool("search_episodes",{title:"Search episodes",description:"Finds Chain of Thought episodes by topic, guest, company, title or chapter title. Returns at most 20 ranked episodes with date, guests, short summary, matching chapters and canonical url to cite.",inputSchema:searchEpisodesSchema,annotations},args=>wrap("search_episodes",()=>searchEpisodes(env.DB,args)));
  server.registerTool("get_episode",{title:"Get episode",description:"Returns one episode by number or slug: title, date, duration, guests with companies, summary, chapters and episode, YouTube and audio links. Does not return the transcript. Cite its url.",inputSchema:getEpisodeSchema,annotations},args=>wrap("get_episode",()=>getEpisode(env.DB,args)));
  server.registerTool("get_transcript_excerpt",{title:"Get transcript excerpt",description:"Returns up to 16 consecutive transcript segments around a timestamp (m:ss or h:mm:ss) or segment index. Each segment has its own url to cite. Provide one episode number.",inputSchema:getExcerptSchema,annotations},args=>wrap("get_transcript_excerpt",()=>getTranscriptExcerpt(env.DB,args)));
  return server;
}
