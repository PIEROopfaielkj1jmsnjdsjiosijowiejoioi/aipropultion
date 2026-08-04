import { DurableObject } from "cloudflare:workers";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function validHeartbeat(input) {
  const id = clean(input.id, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) return null;
  const status = clean(input.status || "running", 24).toLowerCase();
  if (!["starting", "running", "waiting", "blocked", "completed", "failed", "stopped"].includes(status)) return null;
  const name = clean(input.name, 80);
  const task = clean(input.task, 500);
  if (!name || !task) return null;
  return {
    id,
    name,
    kind: clean(input.kind || "Agent", 80),
    purpose: clean(input.purpose, 500),
    project: clean(input.project, 120),
    task,
    detail: clean(input.detail, 1000),
    source: clean(input.source, 240),
    status
  };
}

async function sameSecret(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export class AgentWorkspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        purpose TEXT NOT NULL,
        project TEXT NOT NULL,
        task TEXT NOT NULL,
        detail TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        detail TEXT NOT NULL,
        happened_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_recent ON activity(happened_at DESC);
    `);
  }

  record(agent) {
    const now = Date.now();
    const previous = this.ctx.storage.sql.exec(
      "SELECT status, task, started_at FROM agents WHERE id = ?",
      agent.id
    ).toArray()[0];
    const startedAt = previous && previous.task === agent.task ? previous.started_at : now;
    this.ctx.storage.sql.exec(`
      INSERT INTO agents (id, name, kind, purpose, project, task, detail, source, status, started_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, kind=excluded.kind, purpose=excluded.purpose,
        project=excluded.project, task=excluded.task, detail=excluded.detail,
        source=excluded.source, status=excluded.status,
        started_at=excluded.started_at, last_seen=excluded.last_seen
    `, agent.id, agent.name, agent.kind, agent.purpose, agent.project, agent.task,
      agent.detail, agent.source, agent.status, startedAt, now);
    if (!previous || previous.status !== agent.status || previous.task !== agent.task) {
      this.ctx.storage.sql.exec(
        "INSERT INTO activity (agent_id, agent_name, status, task, detail, happened_at) VALUES (?, ?, ?, ?, ?, ?)",
        agent.id, agent.name, agent.status, agent.task, agent.detail, now
      );
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM activity WHERE happened_at < ?",
      now - 30 * 24 * 60 * 60 * 1000
    );
    return { accepted: true, observedAt: new Date(now).toISOString() };
  }

  status() {
    const now = Date.now();
    const agents = this.ctx.storage.sql.exec(
      "SELECT * FROM agents ORDER BY last_seen DESC"
    ).toArray().map(agent => ({
      ...agent,
      live: ["starting", "running", "waiting", "blocked"].includes(agent.status) && now - agent.last_seen < 45000,
      startedAt: new Date(agent.started_at).toISOString(),
      lastSeen: new Date(agent.last_seen).toISOString(),
      started_at: undefined,
      last_seen: undefined
    }));
    const activity = this.ctx.storage.sql.exec(
      "SELECT agent_id, agent_name, status, task, detail, happened_at FROM activity ORDER BY happened_at DESC LIMIT 50"
    ).toArray().map(event => ({
      id: event.agent_id,
      agent: event.agent_name,
      status: event.status,
      task: event.task,
      detail: event.detail,
      at: new Date(event.happened_at).toISOString()
    }));
    return { observedAt: new Date(now).toISOString(), agents, activity };
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: jsonHeaders });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return response({ ok: true });
    const workspace = env.AGENT_WORKSPACE.getByName("ai-propulsion");
    if (request.method === "GET" && url.pathname === "/v1/status") return response(await workspace.status());
    if (request.method === "POST" && url.pathname === "/v1/heartbeat") {
      const authorization = request.headers.get("authorization") || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!(await sameSecret(token, env.HEARTBEAT_TOKEN))) return response({ error: "Unauthorized" }, 401);
      if (Number(request.headers.get("content-length") || 0) > 16384) return response({ error: "Payload too large" }, 413);
      let input;
      try { input = await request.json(); } catch { return response({ error: "Invalid JSON" }, 400); }
      const agent = validHeartbeat(input);
      if (!agent) return response({ error: "Invalid heartbeat" }, 400);
      return response(await workspace.record(agent), 202);
    }
    return response({ error: "Not found" }, 404);
  }
};
