"use strict";

/**
 * GitHub Bounties strategy for MarketplacePipeline — real, paid open-source
 * work via Algora (https://algora.io), the most established GitHub-native
 * bounty platform. No separate API key needed: bounties live as normal
 * public GitHub issues that Algora's bot has labeled/commented on with a
 * dollar amount, and are claimed with normal GitHub actions (a comment,
 * then a pull request) — all through the GITHUB_TOKEN already configured.
 *
 * IMPORTANT — this strategy is intentionally scoped to the SAFE half of
 * the workflow only:
 *   1. Discover open bounty issues across public GitHub (search API).
 *   2. Draft an "/attempt" comment (implementation plan) — this is the
 *      "communication" capability, same risk tier as every other
 *      strategy in this project.
 *   3. On approval, post that comment to the real issue.
 *
 * It deliberately does NOT write code or open a pull request
 * automatically. Actually solving the bounty (reading the repo, making
 * the fix, opening a PR with "/claim #<number>" in the body) is a much
 * bigger, higher-risk autonomous action than anything else this project
 * does today, and is left as a manual next step once the agent has
 * signaled interest. Treat a submitted "/attempt" as a lead, not a
 * finished job.
 *
 * FIX #1 — owner/repo/number extraction in toTask():
 * The previous version only looked at `raw.repository_url` and `raw.number`.
 * extractRepoIdentity() now tries every known field name (repository_url,
 * repository.url, repository.html_url, url, html_url) and both API and HTML
 * URL shapes, and names the missing field(s) precisely instead of printing
 * `undefined`.
 *
 * FIX #2 — owner/repo/number extraction in submit():
 * The pipeline passes `opportunity.raw` (the ORIGINAL GitHub issue object)
 * to submit(), NOT the enhanced `task.input.raw` that toTask() builds. The
 * original issue has NO `.owner`/`.repo` fields — GitHub puts them inside
 * `repository_url`/`html_url`/`url`. Previous submit() read `raw.owner`
 * directly and therefore ALWAYS threw "Could not determine owner/repo"
 * even when toTask() had successfully resolved them.
 * submit() now calls extractRepoIdentity(raw) itself, exactly like toTask()
 * does, so it gets the same values that were used to build the goal text.
 */

const MIN_BOUNTY_USD = Number(process.env.GITHUB_BOUNTY_MIN_USD || 20);

function parseBountyUsd(issue) {
  const text = `${issue.title || ""} ${issue.body || ""}`;
  const match = text.match(/\$(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/**
 * Extract { owner, repo, number } from a GitHub issue object, trying every
 * documented field name. Returns the resolved values plus a `missing` list
 * of any pieces that couldn't be found, so callers can log precise
 * diagnostics instead of `undefined`.
 *
 * GitHub API reference (search issues response) — relevant fields:
 *   repository_url: "https://api.github.com/repos/OWNER/REPO"
 *   html_url:       "https://github.com/OWNER/REPO/issues/NUMBER"
 *   url:            "https://api.github.com/repos/OWNER/REPO/issues/NUMBER"
 *   number:         NUMBER (integer)
 */
function extractRepoIdentity(raw) {
  const repoUrlCandidates = [
    raw.repository_url,
    raw.repository?.url,
    raw.repository?.html_url,
    raw.url,       // api.github.com/repos/OWNER/REPO/issues/N
    raw.html_url,  // github.com/OWNER/REPO/issues/N
  ].filter((v) => typeof v === "string" && v.length > 0);

  let owner = null;
  let repo = null;
  for (const url of repoUrlCandidates) {
    // Try the API shape first: /repos/OWNER/REPO
    let m = url.match(/\/repos\/([^/]+)\/([^/?#]+)/);
    if (!m) {
      // Then the HTML shape: github.com/OWNER/REPO
      m = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    }
    if (m) {
      owner = m[1];
      repo = m[2];
      break;
    }
  }

  // The issue number can be a top-level integer, or the trailing segment
  // of any of the same URLs.
  let number = null;
  if (Number.isInteger(raw.number)) {
    number = raw.number;
  } else if (typeof raw.number === "string" && /^\d+$/.test(raw.number)) {
    number = Number(raw.number);
  } else {
    for (const url of repoUrlCandidates) {
      const m = url.match(/\/issues\/(\d+)/) || url.match(/\/(\d+)\/?$/);
      if (m) {
        number = Number(m[1]);
        break;
      }
    }
  }

  const missing = [];
  if (!owner) missing.push("owner (repository_url/repository.url/url/html_url)");
  if (!repo) missing.push("repo (repository_url/repository.url/url/html_url)");
  if (!number) missing.push("number (raw.number or trailing /issues/N)");

  return { owner, repo, number, missing };
}

const githubBountiesStrategy = {
  connectorName: "github",

  discoverOperation: "searchIssues",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    // "💎" is the emoji Algora's bot uses in its bounty badge comment.
    const issues = await connector.searchIssues('is:issue is:open "💎" in:comments', { limit: 20 });
    // Attach the parsed bounty amount so toOpportunity doesn't need to
    // re-fetch anything.
    return issues.map((issue) => ({ ...issue, _bountyUsd: parseBountyUsd(issue) }));
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "github_bounty",
    rewardUsd: typeof raw._bountyUsd === "number" && raw._bountyUsd >= MIN_BOUNTY_USD ? raw._bountyUsd : 0,
    // Real coding work, not just a proposal — success is far less certain
    // than a simple marketplace bid.
    successProbability: Number(process.env.GITHUB_BOUNTY_DEFAULT_WIN_RATE || 0.15),
    estimatedModelCostUsd: 0,
    platformFeeUsd: 0,
    riskLevel: "MEDIUM",
  }),

  toTask: (raw) => {
    const { owner, repo, number, missing } = extractRepoIdentity(raw);

    if (missing.length > 0) {
      // Precise diagnostic — names the exact missing field(s) instead of
      // printing `undefined`, so the next failure is debuggable from logs
      // alone without re-instrumenting the code.
      console.warn(
        `[githubBounties] Cannot build task for issue id=${raw.id} title="${(raw.title || "").slice(0, 60)}": missing ${missing.join(", ")}.`
      );
    }

    return {
      id: `github-bounty-attempt-${raw.id}`,
      type: "communication",
      input: {
        context: `Open Algora bounty on GitHub — "${raw.title}" (${owner || "?"}/${repo || "?"}#${number || "?"}). Amount: $${raw._bountyUsd ?? "unspecified"}. Issue body: ${(raw.body || "n/a").slice(0, 800)}`,
        goal:
          'Draft a short "/attempt" comment for this GitHub issue: start the comment with "/attempt #' +
          (number || raw.id) +
          '" on its own line, then 2-4 sentences outlining a concrete implementation plan. Do not write actual code.',
        // Store the resolved identity alongside the raw object so submit()
        // does not have to re-derive it (and gets the exact same values
        // that were used to build the goal text above).
        raw: { ...raw, owner, repo, number },
      },
      untrustedContent: raw.body,
      untrustedSource: "github-issue-body",
      sourceConnector: "github",
    };
  },

  submitOperation: "createIssueComment",
  submitPermission: "SUBMIT_TASK",
  submit: (connector, raw, commentText) => {
    // FIX: `raw` here is the ORIGINAL GitHub issue object (opportunity.raw
    // from the pipeline), NOT the enhanced `task.input.raw` that toTask()
    // builds. The original issue never has `.owner` / `.repo` fields —
    // GitHub puts them inside `repository_url` / `html_url` / `url`. So
    // submit() must re-extract them here with the same helper toTask()
    // uses, instead of reading raw.owner / raw.repo which are always
    // undefined at this layer.
    const { owner, repo, number, missing } = extractRepoIdentity(raw);

    if (!owner || !repo) {
      throw new Error(
        `Could not determine owner/repo for issue id=${raw.id} number=${raw.number} — skipping comment. ` +
          `Missing: ${missing.join(", ")}. ` +
          `Available keys: [${Object.keys(raw).slice(0, 30).join(", ")}]`
      );
    }
    if (!number) {
      throw new Error(
        `Could not determine issue number for issue id=${raw.id} (owner=${owner}, repo=${repo}) — skipping comment.`
      );
    }
    return connector.createIssueComment(owner, repo, number, commentText);
  },
};

module.exports = githubBountiesStrategy;
