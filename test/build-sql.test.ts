import { expect, it } from "vitest";
import { generateSql } from "../scripts/build-sql.ts";
import { D1Shim } from "./helpers/d1-shim.ts";
import { files, manifest, nullTimeEpisode } from "./helpers/fixtures.ts";

it("loads twice, keeps quotes, splits statements, and rebuilds FTS", async () => {
  const sql = await generateSql(manifest(), files, {
    now: "2026-01-02T00:00:00.000Z",
    statementLimitBytes: 2300,
  });
  const inserts = sql.match(/INSERT INTO segments \([^;]+;/gu) ?? [];
  expect(inserts.length).toBeGreaterThan(3);
  for (const statement of inserts) {
    expect(new TextEncoder().encode(statement).length).toBeLessThan(2300);
  }

  const shim = new D1Shim();
  await shim.exec(sql);
  await shim.exec(sql);
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get())
    .toMatchObject({ n: 3 });
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM segments").get())
    .toMatchObject({ n: 8 });
  expect(shim.sqlite.prepare("SELECT text FROM segments WHERE text LIKE ?")
    .get("%O'Brien%")).toMatchObject({ text: "O'Brien built this system." });
  expect(shim.sqlite.prepare(`
    SELECT count(*) AS n FROM segments_fts WHERE segments_fts MATCH ?
  `).get('"memory"')).toMatchObject({ n: 3 });

  const only = await generateSql(manifest(), [files[0]], {
    now: "2026-01-03T00:00:00.000Z", only: [2],
  });
  await shim.exec(only);
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get())
    .toMatchObject({ n: 3 });
  shim.close();
});

it("writes SQL NULL for segments without timestamps", async () => {
  const shim = new D1Shim();
  await shim.exec(await generateSql(manifest([nullTimeEpisode]), [nullTimeEpisode], {
    now: "2026-01-02T00:00:00.000Z",
  }));
  expect(shim.sqlite.prepare(`
    SELECT time, seconds FROM segments WHERE episode = 2 AND idx = 0
  `).get()).toEqual({ time: null, seconds: null });
  shim.close();
});
