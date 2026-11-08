#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readMode, resolveCaller } from "./core/identity.js";
import { startLive, type Live } from "./core/live.js";
import { agentReadyTools } from "./core/agent-tools.js";
import { AGENT_CEILINGS } from "./agent-capabilities.js";
import { buildMcpServer } from "./core/tool.js";
import { migrate, openDb } from "./core/db.js";
import { Store } from "./core/store.js";
import type { Backend } from "./core/backend.js";
import { list, readSecretFile } from "./core/config.js";
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

let backend: Backend; let caller; let live: Live | undefined;
if (mode === "live") {
  live = await startLive(env, CAPS, AGENT_CEILINGS);
  backend = live.backend; caller = live.caller;
} else {
  caller = resolveCaller(mode, env, USERS);
  backend = createFixtureBackend();
}
const classifier = env.DECISION_CLASSIFIER === "jev"
  ? await createJevClassifier({ apiKey: readSecretFile(env.TYPESAFE_API_KEY_FILE ?? "", "TYPESAFE_API_KEY_FILE"), model: env.TYPESAFE_MODEL })
  : undefined;
const app = createPeopleAgent({ backend, store, classifier, jevMinConfidence: env.JEV_MIN_CONFIDENCE ? Number(env.JEV_MIN_CONFIDENCE) : undefined });
if (live?.registry) app.tools.push(...agentReadyTools({ registry: live.registry, store, ceilings: AGENT_CEILINGS, listPermission: "pc.self.read", workerId: live.workerIdFor }));
const server = buildMcpServer({ name: "internal-people-agent", version: "0.2.0", title: "Internal People Agent | Workday MCP" }, app.tools, app.roles, store, caller, list(env.DISABLED_TOOLS));
await server.connect(new StdioServerTransport());
process.stderr.write(`internal-people-agent (Workday MCP): ${mode} mode, classifier ${classifier ? "jev" : "client"}\n`);
