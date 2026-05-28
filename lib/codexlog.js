import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const CHAT_BODY_MARKERS = [
  "response.",
  "SSE event:",
  "op.dispatch.user_input",
  "item/agentMessage",
  "item/assistantMessage",
  "submission.id=",
  "session_loop{thread_id=",
  "turn.id=",
  "markdown_stream",
];

const CHAT_TARGETS_ALWAYS = new Set([
  "codex_api::sse::responses",
  "codex_app_server::outgoing_message",
  "codex_client::transport",
  "codex_core::session::turn",
  "codex_core::stream_events_utils",
  "codex_tui::markdown_stream",
]);

const USER_PROMPT_MARKER = "User prompt:\\n";
const USER_INPUT_RE = /Text \{ text: "((?:\\.|[^"\\])*)"/;
const LOG_SESSION_ID_RE = /(?:conversation\.id|thread_id|thread\.id)=([0-9a-fA-F-]{36})/g;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const RUNTIME_DIR = path.join(PROJECT_ROOT, ".runtime", "codexlog_node");
const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_ORANGE = "\x1b[38;5;208m";
const ANSI_RED = "\x1b[31m";
let sqlModulePromise;

function supportsColor(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (!stream || !stream.isTTY) return false;
  const term = String(env.TERM || "");
  if (term === "dumb") return false;
  if (process.platform === "win32") return true;
  if (/color|ansi|cygwin|linux|screen|xterm|vt100/i.test(term)) return true;
  return Boolean(env.COLORTERM);
}

function colorText(text, color, enabled = supportsColor()) {
  return enabled ? `${color}${text}${ANSI_RESET}` : text;
}

export function defaultCodexRoot(env = process.env, platform = process.platform) {
  if (env.CODEX_ROOT) return path.resolve(expandHome(env.CODEX_ROOT));
  if (platform === "win32" && env.USERPROFILE) return path.join(env.USERPROFILE, ".codex");
  return path.join(os.homedir(), ".codex");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function newRecord(sid) {
  return {
    sid,
    threadExists: false,
    threadTitle: "",
    threadSource: "",
    threadCwd: "",
    threadCreatedAt: 0,
    threadUpdatedAt: 0,
    historyCount: 0,
    historyLastTs: 0,
    historyFirstText: "",
    historyLastText: "",
    firstQuestionText: "",
    firstAnswerText: "",
    logCount: 0,
    logLastTs: 0,
    rolloutCount: 0,
    rolloutMtime: 0,
    rolloutPath: "",
    rolloutPaths: [],
    rolloutTitle: "",
    rolloutSource: "",
    rolloutCwd: "",
    indexCount: 0,
    indexName: "",
    indexUpdatedAt: 0,
    sessionJsonlCount: 0,
    sessionJsonlLastTs: 0,
    sessionJsonlLabel: "",
    auxCount: 0,
    auxLabel: "",
    logPromptText: "",
    sortKey: 0,
  };
}

function getRecord(records, sid) {
  if (!records.has(sid)) records.set(sid, newRecord(sid));
  return records.get(sid);
}

function updateSortKey(record, candidate) {
  if (candidate > record.sortKey) record.sortKey = candidate;
}

function parseEpoch(value) {
  if (value === null || value === undefined || typeof value === "boolean") return 0;
  if (typeof value === "number") {
    const num = Math.trunc(value);
    return Math.abs(num) >= 10 ** 12 ? Math.trunc(num / 1000) : num;
  }
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const num = Number.parseInt(text, 10);
    return text.length > 10 ? Math.trunc(num / 1000) : num;
  }
  const ts = Date.parse(text.replace("Z", "+00:00"));
  return Number.isNaN(ts) ? 0 : Math.trunc(ts / 1000);
}

function loadJson(line) {
  try {
    const obj = JSON.parse(line);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function textWidth(text) {
  let width = 0;
  for (const char of text) {
    width += /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
  }
  return width;
}

function clipWidth(text, limit) {
  const normalized = String(text || "").split(/\s+/).filter(Boolean).join(" ");
  if (limit <= 0) return "";
  let width = 0;
  let out = "";
  for (const char of normalized) {
    const charWidth = textWidth(char);
    if (width + charWidth > Math.max(0, limit - 1)) break;
    out += char;
    width += charWidth;
  }
  return out === normalized ? out : `${out}…`;
}

function compact(text, limit = 36) {
  return clipWidth(text, limit);
}

function fit(text, limit) {
  const clipped = clipWidth(text, limit);
  return clipped + " ".repeat(Math.max(0, limit - textWidth(clipped)));
}

function candidateValues(obj, keys) {
  const values = [];
  for (const key of keys) if (obj?.[key]) values.push(String(obj[key]));
  if (obj?.payload && typeof obj.payload === "object") {
    for (const key of keys) if (obj.payload[key]) values.push(String(obj.payload[key]));
  }
  return values;
}

function extractSessionIds(obj) {
  const ids = [];
  for (const key of ["session_id", "id", "sessionId", "thread_id"]) if (obj?.[key]) ids.push(String(obj[key]));
  if (obj?.payload && typeof obj.payload === "object") {
    for (const key of ["session_id", "id", "sessionId", "thread_id"]) if (obj.payload[key]) ids.push(String(obj.payload[key]));
  }
  return [...new Set(ids)];
}

function extractLabel(obj) {
  const values = candidateValues(obj, [
    "thread_name",
    "title",
    "name",
    "summary",
    "rollout_summary",
    "agent_name",
    "text",
    "first_text",
    "last_text",
    "preview",
  ]);
  return values[0] || "";
}

function decodeDebugString(text) {
  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text;
  }
}

function extractUserPrompt(body) {
  if (!body) return "";
  const idx = body.indexOf(USER_PROMPT_MARKER);
  if (idx !== -1) {
    const snippet = body.slice(idx + USER_PROMPT_MARKER.length);
    for (const sentinel of ['", text_elements', '", environments', '"],', '"}', "\n"]) {
      const end = snippet.indexOf(sentinel);
      if (end !== -1) {
        const candidate = snippet.slice(0, end).trim();
        if (candidate) return candidate;
      }
    }
  }
  const match = USER_INPUT_RE.exec(body);
  return match ? decodeDebugString(match[1]).trim() : "";
}

function extractMessageText(payload, role, contentType) {
  if (!payload || payload.type !== "message" || payload.role !== role || !Array.isArray(payload.content)) return "";
  const parts = [];
  for (const item of payload.content) {
    if (item && item.type === contentType) {
      const text = String(item.text || "").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function looksLikeContextBlob(text) {
  return [
    "# AGENTS.md instructions",
    "<permissions instructions>",
    "<skills_instructions>",
    "<plugins_instructions>",
    "<collaboration_mode>",
    "<environment_context>",
  ].some((marker) => text.includes(marker));
}

function extractTimestamp(obj) {
  const keys = ["updated_at", "updated_at_ms", "created_at", "created_at_ms", "source_updated_at", "timestamp", "ts", "last_usage"];
  const values = [];
  for (const key of keys) if (obj?.[key] !== undefined && obj[key] !== null) values.push(parseEpoch(obj[key]));
  if (obj?.payload && typeof obj.payload === "object") {
    for (const key of keys) if (obj.payload[key] !== undefined && obj.payload[key] !== null) values.push(parseEpoch(obj.payload[key]));
  }
  return values.length ? Math.max(...values) : 0;
}

function isRuntimePath(filePath) {
  return path.normalize(filePath).split(path.sep).includes(".runtime");
}

function walkFiles(root, predicate, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (isRuntimePath(fullPath)) continue;
    if (entry.isDirectory()) walkFiles(fullPath, predicate, out);
    else if (entry.isFile() && predicate(fullPath)) out.push(fullPath);
  }
  return out;
}

function discoverSqliteDatabases(root, prefix) {
  if (!fs.existsSync(root)) return [];
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(?:_(\\d+))?\\.sqlite$`);
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    if (!match) continue;
    files.push({
      filePath: path.join(root, entry.name),
      version: match[1] === undefined ? -1 : Number.parseInt(match[1], 10),
      name: entry.name,
    });
  }
  return files
    .sort((a, b) => (b.version - a.version) || b.name.localeCompare(a.name))
    .map((item) => item.filePath);
}

function readJsonl(filePath, onObject) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = loadJson(line);
    if (obj) onObject(obj);
  }
}

function scanHistory(root, records) {
  readJsonl(path.join(root, "history.jsonl"), (obj) => {
    if (!obj.session_id) return;
    const record = getRecord(records, String(obj.session_id));
    record.historyCount += 1;
    if (!record.firstQuestionText && obj.text) record.firstQuestionText = String(obj.text);
    const ts = parseEpoch(obj.ts);
    updateSortKey(record, ts);
    if (ts >= record.historyLastTs) {
      record.historyLastTs = ts;
      record.historyLastText = String(obj.text || "");
    }
    if (!record.historyFirstText) record.historyFirstText = String(obj.text || "");
  });
}

function scanSessionJsonl(filePath, records) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || isRuntimePath(filePath)) return;
  readJsonl(filePath, (obj) => {
    const sidList = extractSessionIds(obj);
    if (!sidList.length) return;
    const label = extractLabel(obj);
    const ts = extractTimestamp(obj);
    for (const sid of sidList) {
      const record = getRecord(records, sid);
      record.sessionJsonlCount += 1;
      updateSortKey(record, ts);
      if (ts >= record.sessionJsonlLastTs) record.sessionJsonlLastTs = ts;
      if (label && !record.sessionJsonlLabel) record.sessionJsonlLabel = label;
    }
  });
}

function scanSessionJsonlTree(root, records) {
  const seen = new Set();
  const candidates = [
    ...walkFiles(root, (p) => path.basename(p).includes("session") && p.endsWith(".jsonl")),
    ...walkFiles(path.join(root, "sessions"), (p) => p.endsWith(".jsonl")),
  ];
  for (const filePath of candidates.sort()) {
    if (seen.has(filePath) || path.basename(filePath).startsWith("rollout-")) continue;
    seen.add(filePath);
    scanSessionJsonl(filePath, records);
  }
}

function scanSessionIndex(root, records) {
  readJsonl(path.join(root, "session_index.jsonl"), (obj) => {
    if (!obj.id) return;
    const record = getRecord(records, String(obj.id));
    record.indexCount += 1;
    if (obj.thread_name && !record.indexName) record.indexName = String(obj.thread_name);
    const ts = parseEpoch(obj.updated_at);
    record.indexUpdatedAt = Math.max(record.indexUpdatedAt, ts);
    updateSortKey(record, ts);
  });
}

function scanRollouts(root, records) {
  const sessionsDir = path.join(root, "sessions");
  if (!fs.existsSync(sessionsDir)) return;
  for (const filePath of walkFiles(sessionsDir, (p) => path.basename(p).startsWith("rollout-") && p.endsWith(".jsonl")).sort()) {
    let mtime = 0;
    try {
      mtime = Math.trunc(fs.statSync(filePath).mtimeMs / 1000);
    } catch {
      continue;
    }
    const fileSids = new Set();
    let fileTitle = "";
    let fileSource = "";
    let fileCwd = "";
    let fileQuestionText = "";
    let fileAnswerText = "";
    readJsonl(filePath, (obj) => {
      for (const sid of extractSessionIds(obj)) fileSids.add(sid);
      if (!fileTitle) fileTitle = extractLabel(obj);
      const payload = obj.payload;
      if (payload && typeof payload === "object") {
        if (!fileSource && payload.source !== undefined) fileSource = JSON.stringify(payload.source);
        if (!fileCwd && payload.cwd) fileCwd = String(payload.cwd);
        const userText = extractMessageText(payload, "user", "input_text");
        if (userText && !fileQuestionText && !looksLikeContextBlob(userText)) fileQuestionText = userText;
        const assistantText = extractMessageText(payload, "assistant", "output_text");
        if (assistantText && !fileAnswerText) fileAnswerText = assistantText;
      }
    });
    if (!fileSids.size) {
      const match = UUID_RE.exec(path.basename(filePath));
      if (match) fileSids.add(match[1]);
    }
    for (const sid of fileSids) {
      const record = getRecord(records, sid);
      record.rolloutCount += 1;
      if (!record.rolloutPaths.includes(filePath)) record.rolloutPaths.push(filePath);
      updateSortKey(record, mtime);
      if (mtime >= record.rolloutMtime) {
        record.rolloutMtime = mtime;
        record.rolloutPath = filePath;
        if (fileTitle && !record.rolloutTitle) record.rolloutTitle = fileTitle;
        if (fileSource && !record.rolloutSource) record.rolloutSource = fileSource;
        if (fileCwd && !record.rolloutCwd) record.rolloutCwd = fileCwd;
      }
      if (fileQuestionText && !record.firstQuestionText) record.firstQuestionText = fileQuestionText;
      if (fileAnswerText && !record.firstAnswerText) record.firstAnswerText = fileAnswerText;
    }
  }
}

async function loadSqlModule() {
  if (!sqlModulePromise) {
    sqlModulePromise = initSqlJs({
      locateFile: (file) => fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url)),
    });
  }
  return sqlModulePromise;
}

class SqlJsDatabase {
  constructor(dbPath, sqlModule) {
    this.dbPath = dbPath;
    const bytes = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined;
    this.db = new sqlModule.Database(bytes);
  }

  query(sql) {
    const stmt = this.db.prepare(sql);
    const rows = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  exec(sql, persist = false) {
    this.db.exec(sql);
    if (persist) this.save();
  }

  save() {
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  close() {
    this.db.close();
  }
}

async function openSqlite(dbPath) {
  const sqlModule = await loadSqlModule();
  return new SqlJsDatabase(dbPath, sqlModule);
}

function sqliteQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteString(value) {
  return value === null || value === undefined ? "" : String(value);
}

async function scanStateDb(root, records) {
  for (const dbPath of discoverSqliteDatabases(root, "state")) {
    const db = await openSqlite(dbPath);
    try {
      for (const row of db.query("select id, coalesce(title,'') as title, coalesce(source,'') as source, coalesce(cwd,'') as cwd, coalesce(created_at,0) as created_at, coalesce(updated_at,0) as updated_at, coalesce(created_at_ms,0) as created_at_ms, coalesce(updated_at_ms,0) as updated_at_ms, coalesce(preview,'') as preview, coalesce(first_user_message,'') as first_user_message from threads")) {
        const record = getRecord(records, String(row.id));
        record.threadExists = true;
        if (row.title && !record.threadTitle) record.threadTitle = sqliteString(row.title);
        else if (row.preview && !record.threadTitle) record.threadTitle = sqliteString(row.preview);
        else if (row.first_user_message && !record.threadTitle) record.threadTitle = sqliteString(row.first_user_message);
        if (row.first_user_message && !record.firstQuestionText) record.firstQuestionText = sqliteString(row.first_user_message);
        if (row.source && !record.threadSource) record.threadSource = sqliteString(row.source);
        if (row.cwd && !record.threadCwd) record.threadCwd = sqliteString(row.cwd);
        record.threadCreatedAt = Math.max(record.threadCreatedAt, parseEpoch(row.created_at_ms) || parseEpoch(row.created_at));
        record.threadUpdatedAt = Math.max(record.threadUpdatedAt, parseEpoch(row.updated_at_ms) || parseEpoch(row.updated_at));
        updateSortKey(record, record.threadUpdatedAt || record.threadCreatedAt);
      }

      const auxTables = [
        ["stage1_outputs", "thread_id", "source_updated_at", "rollout_summary"],
        ["thread_dynamic_tools", "thread_id", null, null],
        ["thread_spawn_edges", "parent_thread_id", null, null],
        ["thread_spawn_edges", "child_thread_id", null, null],
        ["agent_job_items", "assigned_thread_id", "updated_at", null],
      ];
      for (const [table, column, tsColumn, labelColumn] of auxTables) {
        let query = "";
        if (tsColumn && labelColumn) query = `select ${column} as sid, coalesce(${tsColumn},0) as ts, coalesce(${labelColumn},'') as label from ${table}`;
        else if (tsColumn) query = `select ${column} as sid, coalesce(${tsColumn},0) as ts from ${table}`;
        else query = `select ${column} as sid from ${table}`;
        for (const row of db.query(query)) {
          if (!row.sid) continue;
          const record = getRecord(records, String(row.sid));
          record.auxCount += 1;
          if (tsColumn) updateSortKey(record, parseEpoch(row.ts));
          if (labelColumn && row.label && !record.auxLabel) record.auxLabel = sqliteString(row.label);
        }
      }
    } catch {
      // Future Codex versions may leave older/incompatible state databases nearby.
    } finally {
      db.close();
    }
  }
}

async function scanLogsDb(root, records) {
  for (const dbPath of discoverSqliteDatabases(root, "logs")) {
    const db = await openSqlite(dbPath);
    try {
      for (const row of db.query("select thread_id, ts, coalesce(feedback_log_body,'') as body from logs where thread_id is not null order by ts, id")) {
        const record = getRecord(records, String(row.thread_id));
        record.logCount += 1;
        const ts = parseEpoch(row.ts);
        record.logLastTs = Math.max(record.logLastTs, ts);
        updateSortKey(record, record.logLastTs);
        const prompt = extractUserPrompt(sqliteString(row.body));
        if (prompt && !record.firstQuestionText) record.firstQuestionText = prompt;
        if (prompt && !record.logPromptText) record.logPromptText = prompt;
      }
    } catch {
      // Future Codex versions may leave older/incompatible log databases nearby.
    } finally {
      db.close();
    }
  }
}

export async function buildInventory(root = defaultCodexRoot()) {
  const records = new Map();
  scanHistory(root, records);
  scanSessionJsonlTree(root, records);
  scanSessionIndex(root, records);
  scanRollouts(root, records);
  await scanStateDb(root, records);
  await scanLogsDb(root, records);
  return [...records.values()].sort((a, b) => (b.sortKey - a.sortKey) || b.sid.localeCompare(a.sid));
}

function displayLabel(record, limit = 18) {
  if (record.firstQuestionText) return compact(record.firstQuestionText, limit);
  if (record.firstAnswerText) return compact(record.firstAnswerText, limit);
  if (record.threadTitle) return compact(record.threadTitle, limit);
  if (record.sessionJsonlLabel) return compact(record.sessionJsonlLabel, limit);
  if (record.historyFirstText) return compact(record.historyFirstText, limit);
  if (record.indexName) return compact(record.indexName, limit);
  if (record.rolloutTitle) return compact(record.rolloutTitle, limit);
  if (record.logPromptText) return compact(record.logPromptText, limit);
  if (record.auxLabel) return compact(record.auxLabel, limit);
  if (record.logCount > 0) return `仅日志（${record.logCount} 条）`;
  if (record.sessionJsonlCount > 0) return "仅 session 文件";
  if (record.rolloutCount > 0) return "仅 rollout 文件";
  if (record.indexCount > 0) return "仅索引";
  if (record.rolloutPath) return compact(path.basename(record.rolloutPath), limit);
  return "未命名";
}

function recordState(record) {
  if (record.threadExists && (record.historyCount || record.logCount || record.rolloutCount || record.indexCount || record.sessionJsonlCount || record.auxCount)) return "活跃";
  if (record.threadExists || record.rolloutCount || record.indexCount || record.sessionJsonlCount || record.auxCount) return "部分";
  return "孤立";
}

function recordStateShort(record) {
  return { "活跃": "活", "部分": "部", "孤立": "孤" }[recordState(record)];
}

function recordSourceSummary(record) {
  const parts = [];
  if (record.threadExists) parts.push("线程表");
  if (record.historyCount) parts.push("history.jsonl");
  if (record.logCount) parts.push("日志表");
  if (record.rolloutCount) parts.push("rollout 文件");
  if (record.indexCount) parts.push("session_index.jsonl");
  if (record.sessionJsonlCount) parts.push("session*.jsonl");
  if (record.auxCount) parts.push("关联表");
  return parts.length ? parts.join("、") : "无";
}

function shortId(sid) {
  return sid.slice(0, 8);
}

function indexWidth(total) {
  return Math.max(2, String(Math.max(total, 1)).length);
}

function renderMenu(records, selected, selectedSids, codexRoot, status = "") {
  const cols = process.stdout.columns || 80;
  const lines = process.stdout.rows || 24;
  const visible = Math.max(5, lines - 9);
  const labelWidth = 40;
  const total = records.length;
  const menuTotal = total + 1;
  const seqWidth = indexWidth(total);
  if (!total) return;
  const safeSelected = Math.max(0, Math.min(selected, menuTotal - 1));
  const start = Math.max(0, safeSelected - visible + 1);
  const end = Math.min(menuTotal, start + visible);
  const allSelected = selectedSids.size === total;
  const formatRecordLine = (record, displayIndex) => {
    let line = `[${selectedSids.has(record.sid) ? "x" : " "}] [${String(displayIndex).padStart(seqWidth, "0")}] ${fit(displayLabel(record, labelWidth), labelWidth)} | ${shortId(record.sid)} | 状:${recordStateShort(record)} 线:${record.threadExists ? "有" : "无"} 历:${record.historyCount} 日:${record.logCount} 回:${record.rolloutCount}`;
    if (line.length > cols) line = line.slice(0, cols);
    return line;
  };
  const firstVisibleRecordIndex = Math.max(0, start - 1);
  const lastVisibleRecordIndex = Math.min(total, end - 1);
  const separatorWidth = Math.max(
    1,
    ...records.slice(firstVisibleRecordIndex, lastVisibleRecordIndex).map((record, idx) => (
      formatRecordLine(record, firstVisibleRecordIndex + idx + 1).length
    )),
  );

  process.stdout.write("\x1b[H\x1b[J");
  console.log("codexlog");
  console.log("警告：清理前请先退出 Codex，避免进程正在写入或锁定数据。");
  console.log(`检测到记录：${total}`);
  console.log("使用 ↑/↓ 移动，D 选择/取消，Enter 删除所选，Esc/q 退出。");
  console.log("说明：线=线程 历=历史 日=日志 回=回滚 索=索引 会=会话 关=关联\n");
  console.log(`已选记录：${selectedSids.size}`);
  console.log(status ? `${status}\n` : "");

  for (let idx = start; idx < end; idx += 1) {
    if (idx === 0) {
      let line = `[${allSelected ? "x" : " "}] 全选彻底删除`;
      if (line.length > cols) line = line.slice(0, cols);
      console.log(idx === safeSelected ? `\x1b[7m${line}\x1b[0m` : line);
      console.log("-".repeat(separatorWidth));
      continue;
    }
    const recordIndex = idx - 1;
    const record = records[recordIndex];
    const displayIndex = recordIndex + 1;
    const line = formatRecordLine(record, displayIndex);
    console.log(idx === safeSelected ? `\x1b[7m${line}\x1b[0m` : line);
  }
}

function readKey() {
  return new Promise((resolve) => {
    const onData = (data) => {
      process.stdin.off("data", onData);
      resolve(data.toString("utf8"));
    };
    process.stdin.on("data", onData);
  });
}

async function promptConfirm(selectedRecords, recursiveCount) {
  process.stdout.write(`\n已选择 ${selectedRecords.length} 条记录，递归后将删除 ${recursiveCount} 条。\n`);
  const preview = selectedRecords.slice(0, 3).map((record) => fit(displayLabel(record), 12)).join(", ");
  if (preview) process.stdout.write(`选择项：${preview}${selectedRecords.length > 3 ? "..." : ""}\n`);
  process.stdout.write("输入 y 后回车删除，输入 n 或 Esc 取消：");
  let buf = "";
  while (true) {
    const key = await readKey();
    if (key === "\x1b") {
      process.stdout.write("\n");
      return false;
    }
    if (key === "\r" || key === "\n") {
      process.stdout.write("\n");
      return buf.toLowerCase() === "y";
    }
    if (key === "y" || key === "Y") {
      buf = "y";
      process.stdout.write("y");
    } else if (key === "n" || key === "N") {
      buf = "n";
      process.stdout.write("n");
    } else if (key === "\x7f" && buf) {
      buf = "";
      process.stdout.write("\b \b");
    }
  }
}

async function promptConfirmFullReset(root, recordCount) {
  const colorEnabled = supportsColor();
  process.stdout.write(`\n已全选 ${recordCount} 条记录，将彻底清理 Codex 本地记录数据。\n`);
  process.stdout.write("------------------------------------------------------------\n");
  process.stdout.write(`${colorText("Codex CLI彻底变干净", ANSI_GREEN, colorEnabled)}，${colorText("Codex Desktop也会变干净但是否有其他影响未知", ANSI_ORANGE, colorEnabled)}，${colorText("如果是Codex Desktop请谨慎使用彻底删除", ANSI_RED, colorEnabled)}。\n`);
  process.stdout.write("------------------------------------------------------------\n");
  process.stdout.write("输入 y 后回车彻底删除，输入 n 或 Esc 取消：");
  let buf = "";
  while (true) {
    const key = await readKey();
    if (key === "\x1b") {
      process.stdout.write("\n");
      return false;
    }
    if (key === "\r" || key === "\n") {
      process.stdout.write("\n");
      return buf.toLowerCase() === "y";
    }
    if (key === "y" || key === "Y") {
      buf = "y";
      process.stdout.write("y");
    } else if (key === "n" || key === "N") {
      buf = "n";
      process.stdout.write("n");
    } else if (key === "\x7f" && buf) {
      buf = "";
      process.stdout.write("\b \b");
    }
  }
}

function chunked(items, size = 500) {
  const chunks = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

function filterJsonlFile(filePath, shouldDrop) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let modified = false;
  let keptAny = false;
  const input = fs.readFileSync(filePath, "utf8");
  const lines = input.split(/(?<=\n)/);
  const out = [];
  for (const raw of lines) {
    const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!line.trim()) {
      if (raw) {
        out.push(raw);
        keptAny = true;
      }
      continue;
    }
    const obj = loadJson(line);
    if (obj && shouldDrop(obj)) {
      modified = true;
      continue;
    }
    out.push(raw);
    keptAny = true;
  }
  if (!modified) return [false, false];
  fs.writeFileSync(tmpPath, out.join(""), "utf8");
  fs.renameSync(tmpPath, filePath);
  return [true, !keptAny];
}

function jsonlMatchesSession(obj, sid) {
  return extractSessionIds(obj).includes(sid);
}

export async function collectRecursiveSessionIds(root, seedSids) {
  const target = new Set([...seedSids].filter(Boolean).map(String));
  if (!target.size) return [];
  const edges = new Map();
  for (const dbPath of discoverSqliteDatabases(root, "state")) {
    const db = await openSqlite(dbPath);
    try {
      for (const row of db.query("select parent_thread_id, child_thread_id from thread_spawn_edges where parent_thread_id is not null and child_thread_id is not null")) {
        const parent = String(row.parent_thread_id);
        const child = String(row.child_thread_id);
        if (!edges.has(parent)) edges.set(parent, new Set());
        edges.get(parent).add(child);
      }
    } catch {
      // Ignore incompatible state databases from other Codex versions.
    } finally {
      db.close();
    }
  }
  const queue = [...target];
  while (queue.length) {
    const sid = queue.pop();
    for (const child of edges.get(sid) || []) {
      if (!target.has(child)) {
        target.add(child);
        queue.push(child);
      }
    }
  }
  return [...target].sort();
}

function rolloutFilenameMatchesSession(filePath, sid) {
  return path.basename(filePath).includes(sid);
}

function isUnderRoot(candidate, root) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function collectRolloutPaths(root, targetSids) {
  const paths = new Set();
  if (!targetSids.size) return [];
  for (const stateDb of discoverSqliteDatabases(root, "state")) {
    const db = await openSqlite(stateDb);
    try {
      for (const chunk of chunked([...targetSids].sort())) {
        const ids = chunk.map(sqliteQuote).join(",");
        for (const row of db.query(`select rollout_path from threads where id in (${ids})`)) {
          if (!row.rollout_path) continue;
          const rolloutPath = path.resolve(root, expandHome(String(row.rollout_path)));
          if (isUnderRoot(rolloutPath, root)) paths.add(rolloutPath);
        }
      }
    } catch {
      // Ignore incompatible state databases from other Codex versions.
    } finally {
      db.close();
    }
  }
  const sessionsDir = path.join(root, "sessions");
  for (const filePath of walkFiles(sessionsDir, (p) => path.basename(p).startsWith("rollout-") && p.endsWith(".jsonl")).sort()) {
    if ([...targetSids].some((sid) => rolloutFilenameMatchesSession(filePath, sid))) {
      paths.add(filePath);
      continue;
    }
    let matched = false;
    readJsonl(filePath, (obj) => {
      if (!matched && [...targetSids].some((sid) => jsonlMatchesSession(obj, sid))) matched = true;
    });
    if (matched) paths.add(filePath);
  }
  return [...paths].filter((p) => fs.existsSync(p) && fs.statSync(p).isFile()).sort();
}

function extractLogRelatedIds(text) {
  const ids = new Set();
  if (!text) return ids;
  for (const match of text.matchAll(LOG_SESSION_ID_RE)) ids.add(match[1]);
  return ids;
}

function logIsChatRelated(target, body) {
  if (CHAT_TARGETS_ALWAYS.has(target)) return true;
  if (target === "codex_otel.log_only" || target === "codex_otel.trace_safe") return CHAT_BODY_MARKERS.some((marker) => body.includes(marker));
  return CHAT_BODY_MARKERS.some((marker) => body.includes(marker));
}

function logRowShouldBeDeleted(threadId, processUuid, target, body, relatedIds, relatedProcessUuids) {
  if (threadId && relatedIds.has(threadId)) return true;
  if (processUuid && relatedProcessUuids.has(processUuid)) return true;
  for (const sid of relatedIds) if (sid && body.includes(sid)) return true;
  if (processUuid && relatedProcessUuids.has(processUuid) && logIsChatRelated(target, body)) return true;
  if (logIsChatRelated(target, body)) {
    for (const sid of relatedIds) if (sid && body.includes(sid)) return true;
  }
  return false;
}

async function collectLogRelatedContext(root, targetSids) {
  const ids = new Set([...targetSids].filter(Boolean).map(String));
  const processUuids = new Set();
  const rows = [];
  if (!ids.size) return [ids, processUuids];
  for (const logsDb of discoverSqliteDatabases(root, "logs")) {
    const db = await openSqlite(logsDb);
    try {
      rows.push(...db.query("select thread_id, process_uuid, coalesce(feedback_log_body,'') as body from logs"));
    } catch {
      // Ignore incompatible log databases from other Codex versions.
    } finally {
      db.close();
    }
  }
  for (let pass = 0; pass < 3; pass += 1) {
    const before = ids.size;
    const beforeProcesses = processUuids.size;
    for (const row of rows) {
      const text = sqliteString(row.body);
      const threadId = sqliteString(row.thread_id);
      const processUuid = sqliteString(row.process_uuid);
      let matched = false;
      if (threadId && ids.has(threadId)) {
        matched = true;
        for (const id of extractLogRelatedIds(text)) ids.add(id);
      } else {
        for (const sid of [...ids]) {
          if (sid && text.includes(sid)) {
            matched = true;
            if (threadId) ids.add(threadId);
            for (const id of extractLogRelatedIds(text)) ids.add(id);
            break;
          }
        }
      }
      if (matched && processUuid) processUuids.add(processUuid);
    }
    if (ids.size === before && processUuids.size === beforeProcesses) break;
  }
  return [ids, processUuids];
}

async function purgeLogsDb(root, targetSids) {
  const deleted = [];
  const [relatedIds, relatedProcessUuids] = await collectLogRelatedContext(root, targetSids);
  if (!relatedIds.size && !relatedProcessUuids.size) return deleted;
  for (const logsDb of discoverSqliteDatabases(root, "logs")) {
    const db = await openSqlite(logsDb);
    try {
      const rowIds = [];
      for (const row of db.query("select id, thread_id, process_uuid, target, coalesce(feedback_log_body,'') as body from logs")) {
        if (logRowShouldBeDeleted(sqliteString(row.thread_id), sqliteString(row.process_uuid), sqliteString(row.target), sqliteString(row.body), relatedIds, relatedProcessUuids)) {
          rowIds.push(String(row.id));
        }
      }
      if (!rowIds.length) continue;
      const statements = ["begin;"];
      for (const chunk of chunked(rowIds)) statements.push(`delete from logs where id in (${chunk.map(sqliteQuote).join(",")});`);
      statements.push("commit;");
      db.exec(statements.join("\n"), true);
      deleted.push(`${path.basename(logsDb)}:logs`);
    } catch {
      // Ignore incompatible log databases from other Codex versions.
    } finally {
      db.close();
    }
  }
  return deleted;
}

export async function purgeSessions(root, sids) {
  const targetSids = new Set([...sids].filter(Boolean).map(String));
  const deleted = [];
  if (!targetSids.size) return deleted;

  for (const filePath of await collectRolloutPaths(root, targetSids)) {
    try {
      fs.unlinkSync(filePath);
      deleted.push(filePath);
    } catch {
      // Continue deleting other storage locations even if one file is locked.
    }
  }

  deleted.push(...await purgeLogsDb(root, targetSids));

  for (const stateDb of discoverSqliteDatabases(root, "state")) {
    const db = await openSqlite(stateDb);
    try {
      const statements = ["begin;"];
      for (const chunk of chunked([...targetSids].sort())) {
        const ids = chunk.map(sqliteQuote).join(",");
        statements.push(`delete from threads where id in (${ids});`);
        statements.push(`delete from stage1_outputs where thread_id in (${ids});`);
        statements.push(`delete from thread_dynamic_tools where thread_id in (${ids});`);
        statements.push(`delete from thread_spawn_edges where parent_thread_id in (${ids}) or child_thread_id in (${ids});`);
        statements.push(`delete from agent_job_items where assigned_thread_id in (${ids});`);
      }
      statements.push("commit;");
      db.exec(statements.join("\n"), true);
      deleted.push(path.basename(stateDb));
    } catch {
      // Ignore incompatible state databases from other Codex versions.
    } finally {
      db.close();
    }
  }

  const candidates = [
    ...walkFiles(root, (p) => path.basename(p).includes("session") && p.endsWith(".jsonl")),
    ...walkFiles(path.join(root, "sessions"), (p) => p.endsWith(".jsonl")),
  ];
  const seen = new Set();
  for (const filePath of candidates.sort()) {
    if (seen.has(filePath) || path.basename(filePath).startsWith("rollout-")) continue;
    seen.add(filePath);
    const [changed, empty] = filterJsonlFile(filePath, (obj) => [...targetSids].some((sid) => jsonlMatchesSession(obj, sid)));
    if (changed) deleted.push(filePath);
    if (changed && empty) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  const history = path.join(root, "history.jsonl");
  if (fs.existsSync(history)) {
    const [changed, empty] = filterJsonlFile(history, (obj) => targetSids.has(String(obj.session_id || "")));
    if (changed) deleted.push("history.jsonl");
    if (changed && empty) {
      try { fs.unlinkSync(history); } catch {}
    }
  }

  const index = path.join(root, "session_index.jsonl");
  if (fs.existsSync(index)) {
    const [changed, empty] = filterJsonlFile(index, (obj) => targetSids.has(String(obj.id || "")));
    if (changed) deleted.push("session_index.jsonl");
    if (changed && empty) {
      try { fs.unlinkSync(index); } catch {}
    }
  }

  return deleted;
}

function splitLinesWithEndings(text) {
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isTomlTableHeader(line) {
  return /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line);
}

function isProjectTrustTable(line) {
  return /^\s*\[projects\.(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\]\s*(?:#.*)?$/.test(line);
}

function isTrustedProjectLine(line) {
  return /^\s*trust_level\s*=\s*(["'])trusted\1\s*(?:#.*)?$/.test(line);
}

function isTomlContentLine(line) {
  return line.trim() !== "" && !line.trimStart().startsWith("#");
}

function removeTrustedProjectsConfig(configPath) {
  if (!fs.existsSync(configPath)) return false;

  let original = "";
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch {
    return false;
  }

  const lines = splitLinesWithEndings(original);
  const output = [];
  let changed = false;

  for (let idx = 0; idx < lines.length;) {
    const line = lines[idx];
    if (!isProjectTrustTable(line)) {
      output.push(line);
      idx += 1;
      continue;
    }

    let end = idx + 1;
    while (end < lines.length && !isTomlTableHeader(lines[end])) end += 1;

    const body = lines.slice(idx + 1, end);
    const trustedBodyIndexes = new Set();
    for (let bodyIdx = 0; bodyIdx < body.length; bodyIdx += 1) {
      if (isTrustedProjectLine(body[bodyIdx])) trustedBodyIndexes.add(bodyIdx);
    }

    if (!trustedBodyIndexes.size) {
      output.push(...lines.slice(idx, end));
      idx = end;
      continue;
    }

    const hasOtherConfig = body.some((bodyLine, bodyIdx) => (
      isTomlContentLine(bodyLine) && !trustedBodyIndexes.has(bodyIdx)
    ));
    if (hasOtherConfig) {
      output.push(...lines.slice(idx, end));
    } else {
      changed = true;
    }
    idx = end;
  }

  if (!changed) return false;

  try {
    fs.writeFileSync(configPath, output.join(""));
    return true;
  } catch {
    return false;
  }
}

export function purgeCodexRootData(root) {
  const deleted = [];
  if (!fs.existsSync(root)) return deleted;

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return deleted;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.sqlite(?:-(?:wal|shm|journal))?$/.test(entry.name)) continue;
    const filePath = path.join(root, entry.name);
    try {
      if (!fs.existsSync(filePath)) continue;
      fs.rmSync(filePath);
      deleted.push(entry.name);
    } catch {
      // Continue deleting other Codex data files even if one file is locked.
    }
  }

  for (const filename of ["history.jsonl", "session_index.jsonl"]) {
    const filePath = path.join(root, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      fs.rmSync(filePath);
      deleted.push(filename);
    } catch {
      // Continue deleting other Codex data files even if one file is locked.
    }
  }

  if (removeTrustedProjectsConfig(path.join(root, "config.toml"))) {
    deleted.push("config.toml:trusted_projects");
  }

  for (const dirname of ["sessions", "logs", "log"]) {
    const dirPath = path.join(root, dirname);
    try {
      if (!fs.existsSync(dirPath)) continue;
      const stat = fs.lstatSync(dirPath);
      if (!stat.isDirectory()) continue;
      fs.rmSync(dirPath, { recursive: true, force: true });
      deleted.push(dirname);
    } catch {
      // Continue deleting other Codex data directories even if one directory is locked.
    }
  }

  return deleted;
}

function usage() {
  console.log("codexlog 用于清理 Codex 日志和 session 对话记录。");
  console.log("警告：清理前请先退出 Codex，避免进程正在写入或锁定数据。");
  console.log("");
  console.log("在终端中输入以下命令即可使用：");
  console.log("  codexlog");
}

export async function main(argv = []) {
  if (argv.length > 0) {
    if (["-h", "--help", "help"].includes(argv[0])) {
      usage();
      return 0;
    }
    usage();
    return 1;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("codexlog needs an interactive terminal.");
    return 1;
  }

  const codexRoot = defaultCodexRoot();
  let records;
  try {
    records = await buildInventory(codexRoot);
  } catch (error) {
    console.error(`Failed to scan ${codexRoot}: ${error.message}`);
    return 1;
  }
  if (!records.length) {
    console.error(`No records found under ${codexRoot}.`);
    return 1;
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  readline.emitKeypressEvents(process.stdin);
  const oldRawMode = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");

  let selected = 0;
  const selectedSids = new Set();
  let status = "";
  try {
    while (true) {
      renderMenu(records, selected, selectedSids, codexRoot, status);
      status = "";
      const key = await readKey();
      if (key === "\x1b" || key === "q" || key === "Q") {
        console.log("\nCancelled.");
        return 0;
      }
      if (key === "\x1b[A" || key === "k" || key === "K") {
        selected = Math.max(0, selected - 1);
      } else if (key === "\x1b[B" || key === "j" || key === "J") {
        selected = Math.min(records.length, selected + 1);
      } else if (key === "d" || key === "D") {
        if (selected === 0) {
          if (selectedSids.size === records.length) selectedSids.clear();
          else for (const record of records) selectedSids.add(record.sid);
        } else {
          const sid = records[selected - 1].sid;
          if (selectedSids.has(sid)) selectedSids.delete(sid);
          else selectedSids.add(sid);
        }
      } else if (key === "\r" || key === "\n") {
        if (!selectedSids.size) {
          status = "未选择任何记录，Enter 无效。";
          continue;
        }
        if (selectedSids.size === records.length) {
          if (await promptConfirmFullReset(codexRoot, records.length)) {
            purgeCodexRootData(codexRoot);
            console.log("\nDone");
            return 0;
          }
          status = "已取消。";
          continue;
        }
        const selectedRecords = records.filter((record) => selectedSids.has(record.sid));
        const recursiveSids = await collectRecursiveSessionIds(codexRoot, selectedSids);
        if (await promptConfirm(selectedRecords, recursiveSids.length)) {
          await purgeSessions(codexRoot, recursiveSids);
          console.log("\nDone");
          return 0;
        }
        status = "已取消。";
      }
    }
  } finally {
    process.stdin.setRawMode(oldRawMode);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h");
  }
}

export const internals = {
  compact,
  defaultCodexRoot,
  displayLabel,
  extractUserPrompt,
  parseEpoch,
  recordSourceSummary,
  recordState,
};
