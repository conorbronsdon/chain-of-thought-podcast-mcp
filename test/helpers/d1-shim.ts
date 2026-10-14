import { DatabaseSync } from "node:sqlite";

type Value = string | number | null;

class StatementShim {
  private values: Value[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: Value[]) {
    this.values = values;
    return this;
  }

  async all<T = Record<string, unknown>>() {
    const results = this.db.prepare(this.sql).all(...this.values) as T[];
    return { results, success: true, meta: {} };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values) as
      Record<string, unknown> | undefined;
    return row ? (column ? row[column] as T : row as T) : null;
  }

  async run<T = Record<string, unknown>>() {
    this.db.prepare(this.sql).run(...this.values);
    return { results: [] as T[], success: true, meta: {} };
  }

  execute() {
    this.db.prepare(this.sql).run(...this.values);
  }
}

export class D1Shim {
  readonly sqlite = new DatabaseSync(":memory:");
  batchCount = 0;
  preparedSql: string[] = [];

  prepare(sql: string) {
    this.preparedSql.push(sql);
    return new StatementShim(this.sqlite, sql);
  }

  async batch<T = Record<string, unknown>>(statements: StatementShim[]) {
    this.batchCount = statements.length;
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const statement of statements) {
        statement.execute();
        out.push({ results: [] as T[], success: true, meta: {} });
      }
      this.sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  close() {
    this.sqlite.close();
  }
}

// Gives SQLite's test shim the D1 surface needed by the production functions.
export function d1(shim: D1Shim): D1Database {
  return shim as unknown as D1Database;
}
