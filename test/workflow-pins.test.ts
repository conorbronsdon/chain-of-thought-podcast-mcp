import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// GitHub Actions hardening: every third-party action is pinned to a full commit SHA
// (tag in a trailing comment), every workflow sets top-level permissions, and
// Dependabot keeps the pins current.
const GH = fileURLToPath(new URL("../.github", import.meta.url));

function unpinnedUses(yaml: string): string[] {
  const bad: string[] = [];
  for (const line of yaml.replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/);
    if (!m) continue;
    const ref = m[1];
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(ref);
  }
  return bad;
}

const yamlFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap(name => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return yamlFiles(p);
        return /\.ya?ml$/.test(name) ? [p] : [];
      })
    : [];

const workflows = yamlFiles(join(GH, "workflows"));
const actionFiles = yamlFiles(join(GH, "actions"));

describe("unpinnedUses", () => {
  it("flags a tag, a short SHA and a branch ref", () => {
    expect(unpinnedUses("      - uses: actions/checkout@v4\n")).toEqual(["actions/checkout@v4"]);
    expect(unpinnedUses("      - uses: actions/checkout@11d5960\n")).toEqual(["actions/checkout@11d5960"]);
    expect(unpinnedUses("        uses: actions/setup-node@main\n")).toEqual(["actions/setup-node@main"]);
  });

  it("accepts a full SHA pin and local actions", () => {
    const yaml = [
      "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
      "      - uses: ./.github/actions/local",
      "      - uses: docker://alpine:3.20",
    ].join("\n");
    expect(unpinnedUses(yaml)).toEqual([]);
  });
});

describe("workflows", () => {
  it("exist", () => expect(workflows.length).toBeGreaterThan(0));

  it.each([...workflows, ...actionFiles])("%s pins every uses: to a full commit SHA", file => {
    expect(unpinnedUses(readFileSync(file, "utf8"))).toEqual([]);
  });

  it.each(workflows)("%s sets top-level permissions", file => {
    expect(readFileSync(file, "utf8")).toMatch(/^permissions:/m);
  });

  it("dependabot watches github-actions", () => {
    expect(readFileSync(join(GH, "dependabot.yml"), "utf8")).toMatch(/package-ecosystem:\s*["']?github-actions\b/);
  });
});
