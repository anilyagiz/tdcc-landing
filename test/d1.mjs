// Minimal in-memory stand-in for Cloudflare D1, backed by node:sqlite, so the
// marketplace API can be tested with `node --test` and no network.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  // node:sqlite numbers ?1/?2 parameters positionally just like D1.
  _stmt() { return this.db.prepare(this.sql); }
  async first() { const r = this._stmt().get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: this._stmt().all(...this.args).map((r) => ({ ...r })) }; }
  async run() {
    if (/\bRETURNING\b/i.test(this.sql)) return { results: this._stmt().all(...this.args), meta: { changes: 1 } };
    const info = this._stmt().run(...this.args);
    return { meta: { changes: Number(info.changes) } };
  }
}

export function createD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0001_marketplace.sql", import.meta.url), "utf8"));
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}
