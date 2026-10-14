import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildFtsQuery } from "../src/fts.ts";

describe("FTS sanitizer", () => {
  it("quotes token runs and removes stopwords", () => {
    expect(buildFtsQuery("multi-agent systems")?.all).toBe('"multi agent" "systems"');
    expect(buildFtsQuery("Qwen's cost")?.all).toBe('"qwen s" "cost"');
    expect(buildFtsQuery("Block MCP rollout 12,000 employees")?.all)
      .toBe('"block" "mcp" "rollout" "12 000" "employees"');
    expect(buildFtsQuery("why multi-agent systems fail")?.all)
      .toBe('"multi agent" "systems" "fail"');
    expect(buildFtsQuery('"exact phrase"')?.all).toBe('"exact" "phrase"');
    expect(buildFtsQuery("AND OR NOT")?.all).toBe('"and" "or" "not"');
    expect(buildFtsQuery("GPT 5")?.terms).toEqual(['"gpt"', '"5"']);
    expect(buildFtsQuery("a b c 5")?.terms).toEqual(['"5"']);
    expect(buildFtsQuery("a guide to evals")?.contentTerms).toEqual(["guide", "evals"]);
    expect(buildFtsQuery("AND OR NOT")?.fill).toBeNull();
    const broad = buildFtsQuery("a how to in guide evals production reliability benchmarking agents")!;
    expect(broad.fill?.split(" OR ")).toHaveLength(4);
    expect(broad.fill).not.toMatch(/"a"|"how"|"to"|"in"/u);
  });

  it("never emits invalid MATCH syntax for hostile or fuzzed text", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE f USING fts5(
        text, tokenize='porter unicode61 remove_diacritics 2'
      );
      INSERT INTO f(text) VALUES ('multi agent systems'), ('database Griciūnas');
    `);
    const check = (input: string) => {
      const query = buildFtsQuery(input);
      if (query) {
        expect(() => db.prepare("SELECT * FROM f WHERE f MATCH ?").all(query.all))
          .not.toThrow();
        expect(() => db.prepare("SELECT * FROM f WHERE f MATCH ?").all(query.any))
          .not.toThrow();
      }
    };
    for (const input of [
      '"', "*", "NEAR(", "-", ":", "AND OR NOT", "", "   ", "x".repeat(1000),
      "title:foo", "foo*", "^bar", "a NEAR/3 b", "(x OR y)", "\u0000", "😀",
      "数据库", "العربية", "Griciūnas", "e\u0301", "İstanbul",
    ]) {
      check(input);
    }
    const alphabet = '" * ( ) : - ^ + { } [ ] , . \' NEAR AND OR NOT abcXYZ09数据库العربية😀';
    let seed = 1234567;
    for (let i = 0; i < 2200; i++) {
      let input = "";
      const length = (seed % 80) + 1;
      for (let j = 0; j < length; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        input += alphabet[seed % alphabet.length];
      }
      check(input);
    }
    db.close();
  });
});
