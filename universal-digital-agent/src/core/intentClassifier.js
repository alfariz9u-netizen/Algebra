"use strict";

const { CAPABILITIES } = require("../capabilities/definitions");

/**
 * Intent/task classification (spec sections 1-3). Cheapest check first:
 * if the task's own `type` field is literally already a capability name
 * (as strategy-generated tasks from MarketplacePipeline always set it to
 * be), use it directly — zero ambiguity, zero cost. Otherwise try
 * deterministic keyword matching. Only genuinely ambiguous input falls
 * back to a single "fast" tier model call, per "minimum necessary
 * intelligence calls."
 */

const KEYWORD_MAP = [
  { capability: "translationLocalization", keywords: ["translate", "translation", "localize", "localization"] },
  { capability: "coding", keywords: ["code", "function", "script", "implement", "api integration", "bug fix", "programming"] },
  { capability: "debugging", keywords: ["debug", "fix this error", "stack trace", "why is this failing"] },
  { capability: "dataAnalysis", keywords: ["csv", "dataset", "analyze data", "spreadsheet", "statistics", "data analysis"] },
  { capability: "documentProcessing", keywords: ["document", "memo", "letter", "report format", "pdf", "docx"] },
  { capability: "contentSeo", keywords: ["blog post", "seo", "content writing", "article", "marketing copy"] },
  { capability: "marketResearch", keywords: ["market analysis", "competitor", "industry trend", "market research"] },
  { capability: "businessAutomation", keywords: ["automate", "workflow", "integration between", "automation"] },
  { capability: "qualityAssurance", keywords: ["validate", "qa", "quality check", "review this output"] },
  { capability: "taskManagement", keywords: ["schedule", "todo", "task list", "prioritize tasks"] },
  { capability: "communication", keywords: ["reply to", "send a message", "draft an email", "respond to"] },
  { capability: "agentDiscovery", keywords: ["find another agent", "hire an agent", "discover agents"] },
  { capability: "serviceDiscovery", keywords: ["find a service", "which platform", "discover service"] },
  { capability: "marketplaceOperations", keywords: ["claim task", "submit bid", "marketplace", "open tasks on"] },
  { capability: "financialAnalysis", keywords: ["expected value", "profit", "cost analysis", "roi", "financial"] },
  { capability: "knowledgeRetrieval", keywords: ["what is", "explain", "look up", "knowledge base"] },
  { capability: "fileAnalysis", keywords: ["this file", "attached file", "hash", "checksum"] },
  { capability: "webResearch", keywords: ["search the web", "find online", "latest news on", "current"] },
  { capability: "research", keywords: ["research", "investigate", "report on"] },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Alnum-aware boundary matching — NOT JavaScript's `\b`, which treats
 * underscore as a word character. That would make "research" fail to
 * match inside "research_report" (a completely normal task-type string),
 * since `\b` sees no boundary between "h" and "_". Using explicit
 * lookaround against [A-Za-z0-9] instead means underscores, spaces, and
 * punctuation all correctly count as separators, while still rejecting
 * "script" matching inside "description" (no separator there at all).
 */
function keywordMatches(text, keyword) {
  if (keyword.includes(" ")) return text.includes(keyword);
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(keyword)}(?![A-Za-z0-9])`, "i");
  return pattern.test(text);
}

function classifyDeterministic(text) {
  const lower = text.toLowerCase();
  for (const { capability, keywords } of KEYWORD_MAP) {
    if (keywords.some((kw) => keywordMatches(lower, kw))) {
      return { capability, method: "deterministic" };
    }
  }
  return null;
}

/**
 * Falls back to a single fast-tier LLM call ONLY if deterministic matching
 * failed — keeping this the exception, not the default path.
 *
 * @param {object|string} taskOrText - either the full task object (preferred
 *   — enables the exact-type-match shortcut) or a pre-built classification
 *   string (legacy call shape, still supported).
 */
async function classify(taskOrText, modelRouter) {
  const isTaskObject = typeof taskOrText === "object" && taskOrText !== null;
  const task = isTaskObject ? taskOrText : null;
  const text = isTaskObject ? `${task.type} ${JSON.stringify(task.input || {})}` : taskOrText;

  if (task && CAPABILITIES[task.type]) {
    return { capability: task.type, method: "exact-type-match" };
  }

  const deterministic = classifyDeterministic(text);
  if (deterministic) return deterministic;

  const capabilities = [...new Set(KEYWORD_MAP.map((k) => k.capability))];
  const systemPrompt = `Classify the task into exactly one of these capabilities: ${capabilities.join(", ")}. Respond with only the capability name, nothing else.`;
  const { text: response } = await modelRouter.generate(systemPrompt, text, "fast");
  const cleaned = response.trim().split(/\s+/)[0];
  const matched = capabilities.find((c) => c.toLowerCase() === cleaned.toLowerCase());

  return { capability: matched || "research", method: "llm-fallback" };
}

module.exports = { classify, classifyDeterministic, KEYWORD_MAP };
