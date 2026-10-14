const STOP = new Set([
  "a", "an", "the", "and", "or", "not", "of", "to", "in", "on", "for", "with",
  "by", "at", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "do", "does", "did", "how", "what", "why",
  "when", "where", "who", "which", "i", "you", "we", "they", "he", "she",
  "my", "your", "our", "their", "me", "us", "about", "into", "can", "could",
  "should", "would",
]);

// Quotes sanitized terms so user syntax cannot reach FTS MATCH directly.
export function buildFtsQuery(input: string): {
  all: string;
  any: string;
  fill: string | null;
  terms: string[];
  contentTerms: string[];
} | null {
  const words = Array.from(input.normalize("NFKC")).slice(0, 200).join("").split(/\s+/u);
  const raw: string[] = [];
  for (const word of words) {
    const runs = (word.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [])
      .slice(0, 8)
      .map(run => Array.from(run.toLowerCase()).slice(0, 64).join(""));
    if (runs.length === 1 && /^[a-z]$/u.test(runs[0])) continue;
    if (runs.length) raw.push(runs.join(" "));
  }
  const hasContent = raw.some(x => x.includes(" ") || !STOP.has(x));
  const useful = hasContent ? raw.filter(x => x.includes(" ") || !STOP.has(x)) : raw;
  const terms = [...new Set(useful.map(x => `"${x}"`))].slice(0, 12);
  const fillTerms = [...new Set(raw.filter(x => x.includes(" ") || !STOP.has(x)))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map(x => `"${x}"`);
  return terms.length ? {
    all: terms.join(" "), any: terms.join(" OR "),
    fill: fillTerms.length > 1 ? fillTerms.join(" OR ") : null,
    terms, contentTerms: [...new Set(raw.filter(x => x.includes(" ") || !STOP.has(x)))],
  } : null;
}
