"use strict";

/**
 * Not part of the shipped product. Spins up a local HTTP server that
 * returns responses shaped EXACTLY like the real Gemini generateContent API,
 * so we can verify our client's parsing logic against the real contract
 * without needing network access or a live API key in this environment.
 */

const http = require("node:http");

/** Deterministic bag-of-words pseudo-embedding for test purposes only. */
function pseudoEmbed(text) {
  const dims = 16;
  const vec = new Array(dims).fill(0);
  const words = String(text).toLowerCase().split(/\W+/).filter(Boolean);
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    vec[h % dims] += 1;
  }
  return vec;
}

function createFixtureServer(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.includes(":generateContent")) {
        // Real Gemini generateContent response shape. If this looks like a
        // QA grading call (system prompt asks for strict JSON scoring),
        // return a realistic scored JSON payload; otherwise a normal
        // agent-style text answer.
        const isQaGradingCall = body.includes("0-100 integer");
        const text = isQaGradingCall
          ? '{"score": 92, "reasoning": "Deliverable is complete, well-structured, and meets stated criteria."}'
          : "Executive summary: fixture research output for testing.";

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text }],
                  role: "model",
                },
                finishReason: "STOP",
              },
            ],
          })
        );
        return;
      }

      if (req.url.includes(":embedContent")) {
        // Real Gemini embedContent response shape — deterministic pseudo-embedding
        // derived from the input text so identical/similar prompts really do
        // produce identical/similar vectors (proves cosine-similarity logic works).
        let payload = "{}";
        try {
          payload = body;
        } catch (e) {
          /* ignore */
        }
        const parsed = JSON.parse(payload || "{}");
        const text = parsed?.content?.parts?.[0]?.text || "";
        const vec = pseudoEmbed(text);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embedding: { values: vec } }));
        return;
      }

      if (req.url.includes("/chat/completions")) {
        // Real xAI/OpenAI-compatible chat completions response shape.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Fixture Grok output." } }],
          })
        );
        return;
      }

      res.writeHead(404);
      res.end("{}");
    });
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { createFixtureServer };
