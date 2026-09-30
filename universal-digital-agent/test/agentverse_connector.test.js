"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

delete require.cache[require.resolve("../src/connectors/agentverse")];
const AgentverseConnector = require("../src/connectors/agentverse");

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    // FIX: must `await fn()` here, not `return fn()` — otherwise `finally`
    // (which restores env vars) runs on the very next microtask, before
    // an async fn's own awaits (bridge calls, fetch) actually complete,
    // wiping the env vars mid-test.
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("status(): listAgents only needs the API key; register needs the API key AND the seed", async () => {
  await withEnv({ AGENTVERSE_API_KEY: "", AGENTVERSE_AGENT_SEED: "" }, () => {
    const c = new AgentverseConnector();
    assert.strictEqual(c.status("listAgents"), "CREDENTIAL_REQUIRED");
    assert.strictEqual(c.status("register"), "CREDENTIAL_REQUIRED");
  });

  await withEnv({ AGENTVERSE_API_KEY: "key123", AGENTVERSE_AGENT_SEED: "" }, () => {
    const c = new AgentverseConnector();
    assert.strictEqual(c.status("listAgents"), "CONNECTED", "search API only needs the key");
    assert.strictEqual(c.status("register"), "CREDENTIAL_REQUIRED", "registration also needs a real identity");
  });

  await withEnv({ AGENTVERSE_API_KEY: "key123", AGENTVERSE_AGENT_SEED: "my-seed" }, () => {
    const c = new AgentverseConnector();
    assert.strictEqual(c.status("listAgents"), "CONNECTED");
    assert.strictEqual(c.status("register"), "CONNECTED");
  });
});

test("getAddress(): calls the bridge once with the seed, then caches the result", async () => {
  let bridgeCalls = 0;
  const fakeBridge = async (command, args) => {
    bridgeCalls += 1;
    assert.strictEqual(command, "address");
    assert.strictEqual(args.seed, "test-seed-phrase");
    return { address: "agent1qtestaddress" };
  };

  await withEnv({ AGENTVERSE_AGENT_SEED: "test-seed-phrase" }, async () => {
    const c = new AgentverseConnector({ bridge: fakeBridge });
    const a1 = await c.getAddress();
    const a2 = await c.getAddress();
    assert.strictEqual(a1, "agent1qtestaddress");
    assert.strictEqual(a2, "agent1qtestaddress");
    assert.strictEqual(bridgeCalls, 1, "address is deterministic — must not re-invoke the bridge on the second call");
  });
});

test("register(): POSTs the exact documented v2 schema with Bearer auth, defaulting url to A2A_SERVER_PUBLIC_URL", async () => {
  const fakeBridge = async () => ({ address: "agent1qmyaddress" });
  let capturedUrl, capturedOptions;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, json: async () => ({ success: true }) };
  };

  try {
    await withEnv(
      {
        AGENTVERSE_API_KEY: "key123",
        AGENTVERSE_AGENT_SEED: "seed",
        A2A_SERVER_PUBLIC_URL: "https://my-agent.example.com/a2a",
      },
      async () => {
        const c = new AgentverseConnector({ bridge: fakeBridge });
        const result = await c.register({ name: "My Agent" });

        assert.strictEqual(capturedUrl, "https://agentverse.ai/v2/agents");
        assert.strictEqual(capturedOptions.method, "POST");
        assert.strictEqual(capturedOptions.headers.Authorization, "Bearer key123");
        const body = JSON.parse(capturedOptions.body);
        assert.strictEqual(body.address, "agent1qmyaddress");
        assert.strictEqual(body.name, "My Agent");
        assert.strictEqual(body.url, "https://my-agent.example.com/a2a");
        assert.strictEqual(body.agent_type, "a2a", "must default to a2a so it routes to our existing a2aServer.js");
        assert.strictEqual(result.address, "agent1qmyaddress");
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("register(): surfaces the real HTTP error instead of pretending success", async () => {
  const fakeBridge = async () => ({ address: "agent1qmyaddress" });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "invalid api key" });

  try {
    await withEnv(
      { AGENTVERSE_API_KEY: "bad-key", AGENTVERSE_AGENT_SEED: "seed", A2A_SERVER_PUBLIC_URL: "https://x.example.com" },
      async () => {
        const c = new AgentverseConnector({ bridge: fakeBridge });
        await assert.rejects(() => c.register({}), /401.*Unauthorized/);
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("listAgents(): POSTs the documented Search API body shape", async () => {
  let capturedUrl, capturedOptions;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, json: async () => [{ address: "agent1qother", name: "Other Agent" }] };
  };

  try {
    await withEnv({ AGENTVERSE_API_KEY: "key123" }, async () => {
      const c = new AgentverseConnector();
      const results = await c.listAgents({ searchText: "financial analysis", limit: 5 });

      assert.strictEqual(capturedUrl, "https://agentverse.ai/v1/search");
      assert.strictEqual(capturedOptions.headers.Authorization, "Bearer key123");
      const body = JSON.parse(capturedOptions.body);
      assert.strictEqual(body.search_text, "financial analysis");
      assert.strictEqual(body.limit, 5);
      assert.ok(Array.isArray(body.filters.agent_type));
      assert.strictEqual(results[0].name, "Other Agent");
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("register()/listAgents() reject clearly when required credentials are missing, instead of making a doomed network call", async () => {
  await withEnv({ AGENTVERSE_API_KEY: "", AGENTVERSE_AGENT_SEED: "" }, async () => {
    const c = new AgentverseConnector();
    await assert.rejects(() => c.register({}), /AGENTVERSE_API_KEY.*AGENTVERSE_AGENT_SEED/);
    await assert.rejects(() => c.listAgents({}), /AGENTVERSE_API_KEY/);
  });
});

test("ConnectorRegistry wires operation-aware status correctly for agentverse (regression for the shared registry fix)", async () => {
  delete require.cache[require.resolve("../src/core/connectorRegistry")];
  const { ConnectorRegistry } = require("../src/core/connectorRegistry");

  await withEnv({ AGENTVERSE_API_KEY: "key123", AGENTVERSE_AGENT_SEED: "" }, () => {
    const registry = new ConnectorRegistry();
    const agentverse = new AgentverseConnector();
    registry.register("agentverse", {
      instance: agentverse,
      capabilities: ["register", "listAgents"],
      statusFn: (operation) => agentverse.status(operation),
    });

    assert.strictEqual(registry.supports("agentverse", "listAgents"), true);
    assert.strictEqual(registry.supports("agentverse", "register"), false);
  });
});
