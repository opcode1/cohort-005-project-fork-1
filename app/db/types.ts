import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema";

// The types domain functions take, so tests can hand in an in-memory
// database (app/test/setup.ts).

export type Db = BetterSQLite3Database<typeof schema>;

/** What `db.transaction` hands its callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** For reads that work inside a transaction or outside one. */
export type Queryable = Db | Tx;
