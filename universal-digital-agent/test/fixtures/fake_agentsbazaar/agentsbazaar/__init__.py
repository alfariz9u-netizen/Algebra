"""
Fake stand-in for the real `agentsbazaar` PyPI package, used only by
test/agentbazaar_bridge.test.js to verify — against the REAL bridge
script, not a copy of it — exactly what arguments
agentbazaar_bridge.py passes to SyncAgentBazaarClient(). Writes what it
was called with to CALL_LOG_PATH (an env var the test sets) so the Node
test can assert on it.
"""
import json
import os


def _log_call(**kwargs):
    log_path = os.environ.get("CALL_LOG_PATH")
    if log_path:
        with open(log_path, "w") as f:
            json.dump(kwargs, f)


class SyncAgentBazaarClient:
    def __init__(self, base_url=None, keypair=None, api_key=None):
        _log_call(base_url=base_url, keypair=str(keypair) if keypair else None, api_key=api_key)
        self.base_url = base_url

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def list_agents(self):
        return [{"name": "fixture-agent"}]

    def stats(self):
        return {"total": 1}

    def call(self, task=None, skills=None):
        return {"task": task, "skills": skills, "status": "accepted"}


def load_keypair():
    return "fake-keypair"
