#!/usr/bin/env node
"use strict";

/**
 * Runs retention pruning (the "database cleanup" this project was missing)
 * against a persisted agent directory. Meant to be run periodically (e.g.
 * a daily cron job), completely independent of any running agent process.
 *
 * Usage:
 *   PERSIST_DIR=./data node src/maintenanceCli.js
 *
 * Configure via env vars (all optional — omitting one skips that limit):
 *   MEMORY_MAX_RECORDS     - cap the memory cache's full history log
 *   AUDIT_MAX_AGE_MS        - delete audit entries older than this
 *   AUDIT_MAX_ENTRIES       - cap audit log to the most recent N entries
 *   ECONOMICS_MAX_AGE_MS    - delete economic events older than this
 *                             (financial totals are preserved via rollup)
 *   ECONOMICS_MAX_ENTRIES   - cap economic events to the most recent N
 *   PERSIST_ENCRYPTION_KEY  - required if the data was written encrypted
 */

const UniversalAgent = require("./core/universalAgent");

function requirePersistDir() {
  const dir = process.env.PERSIST_DIR;
  if (!dir) {
    console.error("PERSIST_DIR is not set — nothing to clean up (in-memory-only agents have nothing to prune).");
    process.exit(1);
  }
  return dir;
}

function main() {
  const persistDir = requirePersistDir();
  const agent = new UniversalAgent({ persistDir });

  console.log(`=== Running maintenance on ${persistDir} ===`);
  const result = agent.runMaintenance();
  console.log(JSON.stringify(result, null, 2));

  const totalRemoved =
    (result.memory.removedExact || 0) +
    (result.memory.removedSemantic || 0) +
    (result.memory.removedRecords || 0) +
    (result.audit.removed || 0) +
    (result.economics.removed || 0);

  console.log(`\nTotal records removed: ${totalRemoved}`);
  console.log("Financial totals (economics.summary()) are unaffected by pruning — preserved via rollup.");
}

main();
