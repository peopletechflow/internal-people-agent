import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { migrate, openDb } from "../src/core/db.js";
import { Store } from "../src/core/store.js";
import { resolveCaller, type Caller } from "../src/core/identity.js";
import { callTool } from "../src/core/tool.js";
import type { Backend } from "../src/core/backend.js";
import { USERS } from "../src/fixtures/data.js";
import { createFixtureBackend } from "../src/fixture-backend.js";
import { createPeopleAgent, type Deps } from "../src/tools.js";

export const as = (u: string): Caller => resolveCaller("fixture", { FIXTURE_USER: u }, USERS);

/** Embedded Postgres (PGlite) with the real migrations; same SQL as production Postgres. */
export async function setup(over: Partial<Deps> & { backend?: Backend; caller?: (u: string) => Caller } = {}) {
  const db = await openDb({ allowEmbedded: true });
  await migrate(db, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  const store = new Store(db);
  const app = createPeopleAgent({ backend: over.backend ?? createFixtureBackend(), store, ...over });
  const who = over.caller ?? as;
  const call = (u: string, name: string, args: unknown = {}) => callTool(app.tools, app.roles, store, who(u), name, args);
  const ok = async (u: string, name: string, args: unknown = {}) => { const r = await call(u, name, args); assert.ok(r.ok, JSON.stringify(r)); return (r as { data: any }).data; };
  return { app, store, db, call, ok };
}
