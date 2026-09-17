"use strict";

/**
 * Real GitHub REST API connector (https://docs.github.com/rest). Minimal
 * on purpose — declares only the operations actually implemented, per spec
 * section 10 ("every connector should expose only the operations that the
 * actual platform supports"). Anything not implemented below is
 * NOT_SUPPORTED by this connector, not silently faked.
 */

const API_BASE = "https://api.github.com";

class GithubConnector {
  constructor() {
    this.name = "GitHub";
  }

  status() {
    return process.env.GITHUB_TOKEN ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  get capabilities() {
    return ["READ_REPOSITORY", "READ_ISSUES", "CREATE_BRANCH", "CREATE_PULL_REQUEST"];
  }

  _headers() {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is not set. Create a fine-grained PAT at https://github.com/settings/tokens");
    }
    return {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async readRepository(owner, repo) {
    const response = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers: this._headers() });
    if (!response.ok) throw new Error(`GitHub repo read failed: ${response.status}`);
    return response.json();
  }

  async readIssues(owner, repo, { state = "open" } = {}) {
    const response = await fetch(`${API_BASE}/repos/${owner}/${repo}/issues?state=${state}`, {
      headers: this._headers(),
    });
    if (!response.ok) throw new Error(`GitHub issue read failed: ${response.status}`);
    return response.json();
  }

  async createBranch(owner, repo, { branchName, fromSha }) {
    const response = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
    });
    if (!response.ok) throw new Error(`GitHub branch creation failed: ${response.status}`);
    return response.json();
  }

  async createPullRequest(owner, repo, { title, head, base, body }) {
    const response = await fetch(`${API_BASE}/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ title, head, base, body }),
    });
    if (!response.ok) throw new Error(`GitHub PR creation failed: ${response.status}`);
    return response.json();
  }
}

module.exports = GithubConnector;
