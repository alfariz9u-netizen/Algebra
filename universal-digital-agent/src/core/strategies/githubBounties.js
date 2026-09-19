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
 */

const MIN_BOUNTY_USD = Number(process.env.GITHUB_BOUNTY_MIN_USD || 20);

function parseBountyUsd(issue) {
  const text = `${issue.title || ""} ${issue.body || ""}`;
  const match = text.match(/\$(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
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
    const repoUrl = raw.repository_url || "";
    const match = repoUrl.match(/repos\/([^/]+)\/([^/]+)$/);
    const owner = match ? match[1] : null;
    const repo = match ? match[2] : null;
    return {
      id: `github-bounty-attempt-${raw.id}`,
      type: "communication",
      input: {
        context: `Open Algora bounty on GitHub — "${raw.title}" (${owner}/${repo}#${raw.number}). Amount: $${raw._bountyUsd ?? "unspecified"}. Issue body: ${(raw.body || "n/a").slice(0, 800)}`,
        goal:
          'Draft a short "/attempt" comment for this GitHub issue: start the comment with "/attempt #' +
          raw.number +
          '" on its own line, then 2-4 sentences outlining a concrete implementation plan. Do not write actual code.',
        raw: { ...raw, owner, repo },
      },
      untrustedContent: raw.body,
      untrustedSource: "github-issue-body",
      sourceConnector: "github",
    };
  },

  submitOperation: "createIssueComment",
  submitPermission: "SUBMIT_TASK",
  submit: (connector, raw, commentText) => {
    if (!raw.owner || !raw.repo) {
      throw new Error(`Could not determine owner/repo for issue ${raw.number} — skipping comment.`);
    }
    return connector.createIssueComment(raw.owner, raw.repo, raw.number, commentText);
  },
};

module.exports = githubBountiesStrategy;
