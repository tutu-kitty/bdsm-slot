#!/usr/bin/env node
/**
 * bdsm-slot — Streamable HTTP MCP server (零依赖, node:http)
 *
 * 端口: PORT (默认 5060), 端点: POST /mcp
 * 门禁: Authorization: Bearer <BDSM_SLOT_TOKEN> (fail closed)
 * 工具: slot_spin / slot_reroll / slot_streak / slot_pool / slot_history
 * 数据: data/pools.json (每次工具调用重新读取 → 改池子即时生效)
 * 历史: data/history.json (append, 上限 1000 条, slot_history 查最近 10)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "5060", 10);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.BDSM_SLOT_TOKEN || "";
const DATA_DIR = path.join(__dirname, "data");
const POOLS_PATH = path.join(DATA_DIR, "pools.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");

// ---------- 数据 ----------
function loadPools() {
  return JSON.parse(fs.readFileSync(POOLS_PATH, "utf-8"));
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveHistory(h) {
  if (h.length > 1000) h = h.slice(-1000);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 1), "utf-8");
}

// ---------- 抽取原语 ----------
function pick(arr, avoidSet) {
  let pool = arr;
  if (avoidSet && avoidSet.size) {
    const filtered = arr.filter((x) => !avoidSet.has(x));
    if (filtered.length) pool = filtered;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickN(arr, n, avoidSet) {
  let pool = arr;
  if (avoidSet && avoidSet.size) {
    const filtered = arr.filter((x) => !avoidSet.has(x));
    if (filtered.length >= n) pool = filtered;
  }
  const s = [...pool];
  const out = [];
  while (out.length < n && s.length) {
    out.push(s.splice(Math.floor(Math.random() * s.length), 1)[0]);
  }
  return out;
}

function chance(p) {
  return Math.random() < p;
}

// ---------- 一轮配方 ----------
// opts: { avoid: Map(slotId->value) | null, intensity: '低'|'中'|'高'|null,
//         include_large: bool, prop_count: int }
function drawRound(pools, opts = {}) {
  const S = (id) => pools.slots.find((s) => s.id === id);
  const avoid = opts.avoid || null;
  const picks = {};

  for (const slot of pools.slots) {
    const av = avoid ? avoid.get(slot.id) : null;
    let avSet = null;
    if (av) {
      if (slot.id === "feature" && typeof av === "object" && !Array.isArray(av)) {
        avSet = new Set(["subpool:" + av.subpool, av.item]);
      } else {
        avSet = new Set(Array.isArray(av) ? av : [av]);
      }
    }

    if (slot.id === "body_parts") {
      // 硬规则: 小穴(骚穴)和屁眼每轮必在, 其余部位随机补足
      const must = ["骚穴", "屁眼"].filter((m) => slot.items.includes(m));
      const rest = slot.items.filter((x) => !must.includes(x));
      const n = Math.max((slot.draw || 3) - must.length, 0);
      picks[slot.id] = [...must, ...pickN(rest, n, avSet)];
      continue;
    }
    if (slot.id === "props") {
      let n = opts.prop_count || (slot.draw_min + Math.floor(Math.random() * (slot.draw_max - slot.draw_min + 1)));
      n = Math.min(n, slot.items.length);
      let items = slot.items;
      if (opts.include_large) {
        // 保证至少 1 件大型 (按前缀区段: 大型区从索引 32 起到 53, 但直接特征匹配更稳)
        items = [...items];
      }
      picks[slot.id] = pickN(items, n, avSet, slot.id);
      continue;
    }
    if (slot.id === "marks") {
      // 留痕(绳子印)只在绳缚或绳类道具时才有意义, 否则不出
      const ropeBondage = picks.bondage && picks.bondage !== "蒙眼加耳塞";
      const ropeProps = Array.isArray(picks.props) && picks.props.some((p) => p === "绳子" || p === "束缚胶带");
      if (!(ropeBondage || ropeProps)) continue;
      if (!chance(0.5)) continue;
      picks[slot.id] = pick(slot.items);
      continue;
    }
    if (slot.chance !== undefined && !chance(slot.chance)) {
      continue;
    }
    const n = slot.draw || 1;
    if (slot.mode === "subpool") {
      // 加演: 先随机子池(避开上轮同子池), 再抽 1 条(避开上轮那条)
      const names = slot.subpools.map((s) => s.name);
      const name = pick(names, avSet);
      const sub = slot.subpools.find((s) => s.name === name);
      picks[slot.id] = { subpool: name, item: pick(sub.items, avSet) };
      continue;
    }
    picks[slot.id] = pickN(slot.items, n, avSet, slot.id);
    if (slot.draw === 1) picks[slot.id] = picks[slot.id][0];
  }

  // 强度覆盖
  if (opts.intensity) picks.intensity = opts.intensity;

  // include_large: 保证道具里有大型区段条目 (大型区段 = "木马" 之后按文档顺序)
  if (opts.include_large) {
    const largeSet = new Set(["木马","加固木马","X架","吊索","屈辱跪凳","束缚调教台","检查椅","囚笼","拘束椅","吊架","分腿架","束缚床","秋千","炮机","真空吸乳器","电动骑乘机","扩张窥器","牙科开口器","牵引颈圈加链","吊环","全身胶带","真空床"]);
    if (!picks.props.some((p) => largeSet.has(p))) {
      picks.props[0] = pick([...largeSet]);
    }
  }
  // 联动: 贞操类标签 → 解除条件; 强度高 → 缓冲项
  const chasityHits = pools.chasity.filter((c) =>
    (picks.actions || []).includes(c) ||
    (picks.training || []).includes(c) ||
    (picks.props || []).includes(c)
  );
  if (chasityHits.length) picks.release = pick(pools.release_pool);
  if (picks.intensity === "高") picks.buffer = pick(pools.buffer_pool);

  return picks;
}

// ---------- 渲染 ----------
function renderRecipe(pools, picks, seq, type) {
  const nameOf = (id) => (pools.slots.find((s) => s.id === id) || {}).name || id;
  const lines = [];
  const head = type === "spin" ? "🎰 第 " + seq + " 期配方" : type === "reroll" ? "🔄 第 " + seq + " 期（重转）" : "🔥 连抽 " + seq + " 期";
  lines.push(head);
  lines.push("▸ 部位：" + picks.body_parts.join(" · "));
  lines.push("▸ 束缚：" + picks.bondage);
  if (picks.training) lines.push("▸ 调教：" + (Array.isArray(picks.training) ? picks.training.join(" + ") : picks.training));
  lines.push("▸ 动作：" + (picks.actions || []).join(" + "));
  if (picks.fluids) lines.push("▸ 体液：" + picks.fluids);
  lines.push("▸ 道具（" + picks.props.length + "）：" + picks.props.join("、"));
  lines.push("▸ 位置：" + picks.location);
  if (picks.timing) lines.push("▸ 时机：" + picks.timing);
  lines.push("▸ 强度：" + picks.intensity);
  if (picks.extras && picks.extras !== "无") lines.push("▸ 附加：" + picks.extras);
  lines.push("▸ 羞辱：" + picks.humiliation);
  lines.push("▸ 惩罚：" + picks.punishment);
  if (picks.feature) lines.push("▸ 加演「" + picks.feature.subpool + "」：" + picks.feature.item);
  if (picks.marks) lines.push("▸ 留痕：" + picks.marks);
  if (picks.feature && picks.feature.item && (picks.props || []).some((p) => picks.feature.item.includes(p))) {
    // 加演条目里提到道具时也触发解除判定
  }
  if (picks.release) {
    lines.push("🔓 解除条件：" + picks.release);
  }
  if (picks.buffer) {
    lines.push("🫧 缓冲项：" + picks.buffer);
  }
  lines.push("💬 \"" + picks.quote + "\"");
  return lines.join("\n");
}

// ---------- 工具实现 ----------
function toolSpin(pools, args, history) {
  const opts = {};
  if (args && args.intensity) opts.intensity = args.intensity;
  if (args && args.include_large) opts.include_large = true;
  if (args && args.prop_count) opts.prop_count = args.prop_count;
  const picks = drawRound(pools, opts);
  return finish(pools, picks, history, "spin");
}

function toolReroll(pools, args, history) {
  const last = history.length ? history[history.length - 1] : null;
  const avoid = new Map();
  if (last && last.picks) {
    for (const [k, v] of Object.entries(last.picks)) avoid.set(k, v);
    if (last.picks.feature && last.picks.feature.subpool) avoid.set("subpool:" + last.picks.feature.subpool, 1);
  }
  const opts = { avoid };
  if (args && args.intensity) opts.intensity = args.intensity;
  if (args && args.include_large) opts.include_large = true;
  if (args && args.prop_count) opts.prop_count = args.prop_count;
  const picks = drawRound(pools, opts);
  return finish(pools, picks, history, "reroll");
}

function toolStreak(pools, args, history) {
  const seqBase = history.length + 1;
  const plan = [
    { intensity: "低", props: 5 },
    { intensity: "中", props: 7, forceExtras: true },
    { intensity: "高", props: 10, forceExtras: true },
  ];
  const rounds = [];
  const texts = [];
  let picksLast = null;
  plan.forEach((p, i) => {
    const opts = { intensity: p.intensity, prop_count: p.props, avoid: picksLast ? mapOf(picksLast) : null };
    const picks = drawRound(pools, opts);
    if (p.forceExtras && (!picks.extras || picks.extras === "无")) {
      const ex = pools.extras_pool.filter((x) => x !== "无");
      picks.extras = ex[Math.floor(Math.random() * ex.length)];
    }
    const seq = seqBase + "-" + (i + 1);
    const text = renderRecipe(pools, picks, seq, "streak");
    rounds.push({ seq, picks, text });
    texts.push("── 第 " + (i + 1) + " 格 ──\n" + text);
    picksLast = picks;
  });
  const combined = texts.join("\n\n");
  const rec = { time: new Date().toISOString(), type: "streak", picks: rounds[2].picks, text: combined };
  const h = loadHistory();
  h.push(rec);
  saveHistory(h);
  return { content: [{ type: "text", text: combined }], rounds: rounds.map((r) => ({ seq: r.seq, picks: r.picks })) };
}

function mapOf(picks) {
  const m = new Map();
  for (const [k, v] of Object.entries(picks)) m.set(k, v);
  return m;
}

function finish(pools, picks, history, type) {
  const seq = history.length + 1;
  const text = renderRecipe(pools, picks, seq, type);
  const rec = { time: new Date().toISOString(), type, picks, text };
  const h = loadHistory();
  h.push(rec);
  saveHistory(h);
  return { content: [{ type: "text", text }] };
}

function toolPool(pools) {
  const lines = [];
  for (const s of pools.slots) {
    if (s.mode === "subpool") {
      lines.push("▸ " + s.name + "（" + s.subpools.length + " 个子池 / " + s.subpools.reduce((a, f) => a + f.items.length, 0) + " 条）：" + s.subpools.map((f) => f.name + "(" + f.items.length + ")").join("、"));
    } else {
      const range = s.draw_min ? s.draw_min + "~" + s.draw_max : s.draw + (s.chance !== undefined ? " (" + Math.round(s.chance * 100) + "% 出现)" : "");
      lines.push("▸ " + s.name + "（" + s.items.length + " 条，每轮 " + range + "）：" + s.items.join("、"));
    }
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function toolHistory(pools, args) {
  const n = (args && args.count) || 10;
  const h = loadHistory();
  const recent = h.slice(-n).reverse();
  if (!recent.length) return { content: [{ type: "text", text: "还没有记录。转一次就有了。" }] };
  const lines = recent.map((r) => "【" + r.time.replace("T", " ").slice(0, 16) + " · " + r.type + "】\n" + r.text);
  return { content: [{ type: "text", text: "最近 " + recent.length + "/" + h.length + " 次：\n\n" + lines.join("\n\n───\n\n") }] };
}

// ---------- MCP 层 ----------
const TOOLS = [
  { name: "slot_spin", description: "转一次，返回这一轮的完整配方（部位/束缚/动作/道具/位置/强度/一句话等）。可选参数: intensity(低/中/高), include_large(必含大型器械), prop_count(道具数量 5-10)。", inputSchema: { type: "object", properties: { intensity: { type: "string", enum: ["低", "中", "高"] }, include_large: { type: "boolean", description: "道具里必含大型器械" }, prop_count: { type: "integer", minimum: 1, maximum: 20, description: "道具数量，默认 5-10 随机" } } } },
  { name: "slot_reroll", description: "不要刚才那次，重转一轮。自动避开上一轮每个格子的结果，不会连着抽到同一个。", inputSchema: { type: "object", properties: { intensity: { type: "string", enum: ["低", "中", "高"] }, include_large: { type: "boolean" }, prop_count: { type: "integer" } } } },
  { name: "slot_streak", description: "连抽三格，逐格加重：第①格低强度基础 → 第②格中强度附加必出 → 第③格高强度+缓冲项。", inputSchema: { type: "object", properties: {} } },
  { name: "slot_pool", description: "列出当前所有池子和条目。只读，不改任何东西。", inputSchema: { type: "object", properties: {} } },
  { name: "slot_history", description: "查询最近的抽取出记录（默认最近 10 次）。", inputSchema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 50, description: "要查几条，默认 10" } } } },
];

function callTool(name, args) {
  const pools = loadPools();
  const history = loadHistory();
  switch (name) {
    case "slot_spin": return toolSpin(pools, args, history);
    case "slot_reroll": return toolReroll(pools, args, history);
    case "slot_streak": return toolStreak(pools, args, history);
    case "slot_pool": return toolPool(pools);
    case "slot_history": return toolHistory(pools, args);
    default: throw new Error("Unknown tool: " + name);
  }
}

function jsonRes(res, id, obj, extraHeaders = {}) {
  const out = JSON.stringify(obj);
  res.writeHead(200, Object.assign({
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(out, "utf-8"),
    "Access-Control-Allow-Origin": "*",
  }, extraHeaders));
  res.end(out);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/ui")) {
    try {
      let html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf-8");
      html = html.replace("__TOKEN__", TOKEN);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("ui missing");
    }
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "bdsm-slot", port: PORT }));
  }
  if (req.method === "POST" && req.url.startsWith("/api/")) {
    const auth = (req.headers["authorization"] || "").trim();
    if (!TOKEN || auth !== "Bearer " + TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const kind = req.url.slice(5);
    const pools = loadPools();
    const history = loadHistory();
    let picks = null, text = "";
    if (kind === "spin" || kind === "reroll") {
      const opts = kind === "reroll" && history.length ? { avoid: mapOf(history[history.length - 1].picks) } : {};
      picks = drawRound(pools, opts);
      const seq = history.length + 1;
      text = renderRecipe(pools, picks, seq, kind);
      history.push({ time: new Date().toISOString(), type: kind, picks, text });
      saveHistory(history);
    } else if (kind === "streak") {
      const ret = toolStreak(pools, {}, history);
      text = ret.content[0].text;
      return jsonRes(res, null, { ok: true, picks: null, text, rounds: ret.rounds || null });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "unknown api" }));
    }
    return jsonRes(res, null, { ok: true, picks, text });
  }

  if (req.method === "POST" && req.url === "/mcp") {
    // Bearer 门禁 (fail closed)
    const auth = (req.headers["authorization"] || "").trim();
    if (!TOKEN || auth !== "Bearer " + TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer realm=\"bdsm-slot\"" });
      return res.end(JSON.stringify({ error: "unauthorized: Bearer token required" }));
    }

    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid json" }));
      }

      const { id, method, params } = msg;
      try {
        if (method === "initialize") {
          return jsonRes(res, id, {
            jsonrpc: "2.0", id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "bdsm-slot", version: "1.0.0" },
            },
          });
        }
        if (method === "notifications/initialized") {
          res.writeHead(204);
          return res.end();
        }
        if (method === "tools/list") {
          return jsonRes(res, id, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
        }
        if (method === "tools/call") {
          let result;
          try {
            result = callTool(params.name, params.arguments || {});
          } catch (e) {
            return jsonRes(res, id, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
          }
          return jsonRes(res, id, { jsonrpc: "2.0", id, result });
        }
        if (id !== undefined) {
          return jsonRes(res, id, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
        }
// JSON-RPC helpers use explicit res (see call sites)
        res.writeHead(204);
        res.end();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found", path: req.url }));
});

server.listen(PORT, HOST, () => {
  console.log(`[bdsm-slot] listening on http://${HOST}:${PORT}/mcp`);
  if (!TOKEN) console.error("[bdsm-slot] WARNING: BDSM_SLOT_TOKEN not set — all requests will be rejected");
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
