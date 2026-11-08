#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { liveCaller, withTenant, readMode, resolveCaller } from "./core/identity.js";
import { buildMcpServer } from "./core/tool.js";
import { migrate, openDb } from "./core/db.js";
import { Store } from "./core/store.js";
import { connectUpstream, Gateway } from "./core/upstream.js";
import { LiveBackend, type Backend } from "./core/backend.js";
import { list, loadMapping, loadRoleMap, readSecretFile } from "./core/config.js";
import { USERS } from "./fixtures/data.js";
import { CAPS } from "./capabilities.js";
import { createFixtureBackend } from "./fixture-backend.js";
import { createJevClassifier } from "./jev.js";
import { createPeopleAgent } from "./tools.js";

const env = process.env;
const mode = readMode(env);
const db = await openDb({ databaseUrl: env.DATABASE_URL, allowEmbedded: mode === "fixture" });
await migrate(db, fileURLToPath(new URL("../db/migrations", import.meta.url)));
const store = new Store(db);

let backend: Backend; let caller;
if (mode === "live") {
  if (!env.WORKDAY_MCP_URL || !env.WORKDAY_MCP_TOKEN_FILE || !env.WORKDAY_MCP_MAPPING_PATH || !env.ROLE_MAP_PATH) throw new Error("Live mode needs WORKDAY_MCP_URL, WORKDAY_MCP_TOKEN_FILE, WORKDAY_MCP_MAPPING_PATH and ROLE_MAP_PATH.");
  const up = await connectUpstream({ url: env.WORKDAY_MCP_URL, accessToken: readSecretFile(env.WORKDAY_MCP_TOKEN_FILE, "WORKDAY_MCP_TOKEN_FILE") });
  const gw = await Gateway.create(up, loadMapping(env.WORKDAY_MCP_MAPPING_PATH), CAPS, { disabled: list(env.DISABLED_CAPABILITIES) });
  if (!gw.isAvailable("identity")) throw new Error("Live mode needs a verified identity capability mapping; refusing to start.");
  caller = liveCaller(withTenant(await gw.invoke("identity", {}), env.WORKDAY_TENANT), loadRoleMap(env.ROLE_MAP_PATH));
  backend = new LiveBackend(gw);
} else {
  caller = resolveCaller(mode, env, USERS);
  backend = createFixtureBackend();
}
const classifier = env.DECISION_CLASSIFIER === "jev"
  ? await createJevClassifier({ apiKey: readSecretFile(env.TYPESAFE_API_KEY_FILE ?? "", "TYPESAFE_API_KEY_FILE"), model: env.TYPESAFE_MODEL })
  : undefined;
const app = createPeopleAgent({ backend, store, classifier, jevMinConfidence: env.JEV_MIN_CONFIDENCE ? Number(env.JEV_MIN_CONFIDENCE) : undefined });
const server = buildMcpServer({ name: "internal-people-agent", version: "0.2.0", title: "Internal People Agent | Workday MCP" }, app.tools, app.roles, store, caller, list(env.DISABLED_TOOLS));
await server.connect(new StdioServerTransport());
process.stderr.write(`internal-people-agent (Workday MCP): ${mode} mode, classifier ${classifier ? "jev" : "client"}\n`);
