import { it,expect } from "vitest";
import { cap,cite,duration,guestStrings,parseAt } from "../src/format.ts";
it("parses indexes and clock times",()=>{
  for(const [at,kind,value] of [["0:29","seconds",29],["12:30","seconds",750],["75:10","seconds",4510],["1:02:03","seconds",3723],["95","index",95],["#t-95","index",95],["t-95","index",95]] as const)expect(parseAt(at)).toEqual({kind,value});
  for(const at of ["12:3","1:60","abc","-1"])expect(parseAt(at)).toBeNull();
});
it("formats duration, caps text and cites URLs",()=>{
  expect(duration(2259)).toBe("37:39");expect(duration(3723)).toBe("1:02:03");
  const text=cap("many words ".repeat(100),600);expect(text.length).toBeLessThanOrEqual(601);expect(text.endsWith("…")).toBe(true);
  expect(cite("https://example.com")).toBe("Chain of Thought, chainofthought.show — https://example.com");
  expect(guestStrings([{name:"Kim",company:"Walrus"},{name:"Jo",company:null}])).toEqual(["Kim (Walrus)","Jo"]);
});
