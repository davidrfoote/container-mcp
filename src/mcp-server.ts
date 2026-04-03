import { randomUUID } from "crypto";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "pg";
import { withDbClient, notifySessionMessage, buildSpawnMessage } from "./db.js";
import { postToFeed, _feedClients } from "./feed.js";
import { taskLogs } from "./task-logs.js";
import { populateCacheForProject, writeCacheEntry } from "./jira-confluence.js";
import { deployProject } from "./tools/deploy-project.js";
import { transitionSession, nextAllowedActions, SESSION_TRANSITIONS, type SessionStatus } from "./state-machine.js";