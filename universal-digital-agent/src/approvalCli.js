#!/usr/bin/env node
"use strict";

/**
 * The human approval interface. Requires PERSIST_DIR to be set to the same
 * directory the agent process is using — approvals are almost always
 * created by one process and resolved by a human in a different one (this
 * CLI), which is exactly why the file-backed persistence layer exists.
 *
 * Usage:
 *   PERSIST_DIR=./data node src/approvalCli.js list [pending|approved|denied]
 *   PERSIST_DIR=./data node src/approvalCli.js show <approvalId>
 *   PERSIST_DIR=./data node src/approvalCli.js approve <approvalId> [resolvedBy]
 *   PERSIST_DIR=./data node src/approvalCli.js deny <approvalId> [resolvedBy]
 *   PERSIST_DIR=./data node src/approvalCli.js resume <approvalId>
 *       (approve + immediately re-run the original task, if it's resumable)
 */

const ApprovalQueue = require("./core/approvalQueue");
const UniversalAgent = require("./core/universalAgent");

function requirePersistDir() {
  const dir = process.env.PERSIST_DIR;
  if (!dir) {
    console.error("PERSIST_DIR is not set. The approval queue only persists across processes when it is.");
    console.error("Example: PERSIST_DIR=./data node src/approvalCli.js list");
    process.exit(1);
  }
  return dir;
}

function printTable(records) {
  if (records.length === 0) {
    console.log("(none)");
    return;
  }
  for (const r of records) {
    console.log(
      `${r.id}\n  status=${r.status}  capability=${r.capability || "-"}  connector=${r.connector || "-"}  action=${r.action}  risk=${r.riskLevel}  requestedAt=${r.requestedAt}  resumable=${r.resumable}`
    );
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const persistDir = requirePersistDir();
  const encryptionKey = process.env.PERSIST_ENCRYPTION_KEY || undefined;
  const queue = new ApprovalQueue({ persistDir, encryptionKey });

  switch (command) {
    case "list": {
      const status = rest[0];
      printTable(queue.list(status ? { status } : {}));
      break;
    }

    case "show": {
      const id = rest[0];
      if (!id) throw new Error("Usage: show <approvalId>");
      const record = queue.get(id);
      if (!record) throw new Error(`No approval found with id "${id}".`);
      console.log(JSON.stringify(record, null, 2));
      break;
    }

    case "approve": {
      const id = rest[0];
      if (!id) throw new Error("Usage: approve <approvalId> [resolvedBy]");
      const record = queue.resolve(id, "approved", rest[1] || "cli-user");
      console.log(`Approved. ${record.resumable ? "Run 'resume " + id + "' to execute it now, or it will resume on the agent's next check." : "This approval has no stored task — nothing to auto-resume."}`);
      break;
    }

    case "deny": {
      const id = rest[0];
      if (!id) throw new Error("Usage: deny <approvalId> [resolvedBy]");
      queue.resolve(id, "denied", rest[1] || "cli-user");
      console.log("Denied.");
      break;
    }

    case "resume": {
      const id = rest[0];
      if (!id) throw new Error("Usage: resume <approvalId>");
      let record = queue.get(id);
      if (!record) throw new Error(`No approval found with id "${id}".`);
      if (record.status === "pending") {
        record = queue.resolve(id, "approved", "cli-user");
        console.log("(auto-approved before resuming, since it was still pending)");
      }
      const agent = new UniversalAgent({ persistDir });
      const result = await agent.resumeTask(id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      console.error("Unknown command. Usage: list | show <id> | approve <id> | deny <id> | resume <id>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
