const STOP = new Set("a an the and or not of to in on for with by at from as is are was were be been it its this that these those do does did how what why when where who which i you we they he she my your our their me us about into can could should would".split(" "));
export function buildFtsQuery(input: string): { all: string; any: string; terms: string[] } | null {
  const words = Array.from(input.normalize("NFKC")).slice(0, 200).join("").split(/\s+/u);
  const raw: string[] = [];
  for (const word of words) {
    const runs = (word.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []).slice(0, 8).map(x => Array.from(x.toLowerCase().replace(/[^\p{L}\p{N}\p{Co}]/gu, "")).slice(0, 64).join(""));
    if (runs.length === 1 && /^[\x00-\x7f]$/u.test(runs[0])) continue;
    if (runs.length) raw.push(runs.join(" "));
  }
  const hasContent = raw.some(x => x.includes(" ") || !STOP.has(x));
  const terms = [...new Set((hasContent ? raw.filter(x => x.includes(" ") || !STOP.has(x)) : raw).map(x => `"${x}"`))].slice(0, 12);
  return terms.length ? { all: terms.join(" "), any: terms.join(" OR "), terms } : null;
}
