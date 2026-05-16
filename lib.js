const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const DATA_DIR = process.env.SCHEDULER_TEST_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'local-scheduler');
const SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');
const AUTOMATIONS_FILE = path.join(DATA_DIR, 'automations.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LAST_ACK_FILE = path.join(DATA_DIR, 'last_ack.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');

const MAX_NOTIFICATIONS_BYTES = 512 * 1024;
const KEEP_NOTIFICATION_LINES = 250;
const TAIL_BYTES = 128 * 1024;

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

// Opt 1: Maps for O(1) lookup by id
const automationsMap = new Map();
const tasksMap = new Map();
const config = {};
let lastAck = 0;

// Built-in automation templates
const BUILTIN_TEMPLATES = [
  {
    id: 'build-project',
    name: 'Build project',
    description: 'Run dotnet build in a project directory every N minutes.',
    defaultInterval: 60,
    scriptType: 'powershell',
    command: 'dotnet build',
    requiredParams: []
  },
  {
    id: 'disk-check',
    name: 'Disk space check',
    description: 'Check available disk space every N minutes.',
    defaultInterval: 5,
    scriptType: 'powershell',
    command: 'Get-PSDrive C | Select-Object Used,Free',
    requiredParams: []
  },
  {
    id: 'git-sync',
    name: 'Git sync',
    description: 'Pull latest changes from git remote every N minutes.',
    defaultInterval: 30,
    scriptType: 'powershell',
    command: 'git pull',
    requiredParams: []
  }
];

let templates = [];

function loadTemplates() {
  templates = [...BUILTIN_TEMPLATES];
  if (fs.existsSync(TEMPLATES_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
      if (Array.isArray(data)) {
        for (const t of data) {
          const idx = templates.findIndex(x => x.id === t.id);
          if (idx >= 0) templates[idx] = t;
          else templates.push(t);
        }
      }
    } catch {}
  }
}

function listTemplates() { return [...templates]; }
function getTemplate(id) { return templates.find(t => t.id === id); }
const SAFE_INTERPOLATED = /^[a-zA-Z0-9_\-\/:. ~]+$/;

function validateInterpolationValue(v) {
  if (!SAFE_INTERPOLATED.test(String(v))) {
    return { ok: false, reason: 'Interpolated value contains forbidden shell characters' };
  }
  return { ok: true };
}

function interpolateTemplate(t, params) {
  let command = t.command || null;
  let script = t.script || null;
  const missing = [];
  const errors = [];

  if (t.requiredParams && Array.isArray(t.requiredParams)) {
    for (const k of t.requiredParams) {
      if (!params || params[k] === undefined) {
        missing.push(k);
      }
    }
  }

  if (missing.length > 0) {
    return { command, script, missing, errors };
  }

  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      const valCheck = validateInterpolationValue(v);
      if (!valCheck.ok) {
        errors.push('param "' + k + '": ' + valCheck.reason);
        continue;
      }
      const placeholder = '${' + k + '}';
      if (command) command = command.split(placeholder).join(String(v));
      if (script) script = script.split(placeholder).join(String(v));
    }
  }
  return { command, script, missing, errors };
}

// Opt 5: write to .tmp then rename for atomicity
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Opt 4: never crash the process on write failure
function safeWrite(filePath, content) {
  try { atomicWrite(filePath, content); } catch {}
}

function loadState() {
  if (fs.existsSync(AUTOMATIONS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8'));
      automationsMap.clear();
      for (const a of data) automationsMap.set(a.id, a);
    } catch {}
  }
  if (fs.existsSync(TASKS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      tasksMap.clear();
      for (const t of data) tasksMap.set(t.id, t);
    } catch {}
  }
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.keys(config).forEach(k => delete config[k]);
      Object.assign(config, data);
    } catch {}
  }
  if (fs.existsSync(LAST_ACK_FILE)) {
    try { lastAck = JSON.parse(fs.readFileSync(LAST_ACK_FILE, 'utf8')).timestamp || 0; } catch {}
  }
}

// Opt 1: CRUD helpers for automations
function getAutomation(id) { return automationsMap.get(id); }
function addAutomation(a) { automationsMap.set(a.id, a); }
function removeAutomation(id) { return automationsMap.delete(id); }
function listAutomations() { return [...automationsMap.values()]; }

// Opt 1: CRUD helpers for tasks
function getTask(id) { return tasksMap.get(id); }
function addTask(t) { tasksMap.set(t.id, t); }
function removeTask(id) { return tasksMap.delete(id); }
function listTasks() { return [...tasksMap.values()]; }

function save() {
  safeWrite(AUTOMATIONS_FILE, JSON.stringify(listAutomations(), null, 2));
}

function saveTasks() {
  safeWrite(TASKS_FILE, JSON.stringify(listTasks(), null, 2));
}

function saveConfig() {
  safeWrite(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function saveAck() {
  safeWrite(LAST_ACK_FILE, JSON.stringify({ timestamp: lastAck }, null, 2));
}

// Opt 3: rotate notifications.jsonl when it exceeds MAX_NOTIFICATIONS_BYTES
function rotateNotificationsIfNeeded() {
  try {
    const stat = fs.statSync(NOTIFICATIONS_FILE);
    if (stat.size <= MAX_NOTIFICATIONS_BYTES) return;
    const content = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const keep = lines.slice(-KEEP_NOTIFICATION_LINES).join('\n') + '\n';
    safeWrite(NOTIFICATIONS_FILE, keep);
  } catch {}
}

function appendNotification(record) {
  const line = JSON.stringify(record) + '\n';
  try {
    fs.appendFileSync(NOTIFICATIONS_FILE, line);
    rotateNotificationsIfNeeded();
  } catch {}
}

// Opt 2: tail-based read — skips loading the full file when it is large
function readNotifications(since = null, limit = 50) {
  if (!fs.existsSync(NOTIFICATIONS_FILE)) return [];
  try {
    const stat = fs.statSync(NOTIFICATIONS_FILE);
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    let text;
    if (fileSize > TAIL_BYTES) {
      const buf = Buffer.alloc(TAIL_BYTES);
      const fd = fs.openSync(NOTIFICATIONS_FILE, 'r');
      try {
        fs.readSync(fd, buf, 0, TAIL_BYTES, fileSize - TAIL_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      // Drop the first (potentially partial) line since we started mid-file
      text = buf.toString('utf8').replace(/^[^\n]*\n/, '');
    } else {
      text = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
    }

    const lines = text.split('\n').filter(Boolean);
    let results = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (since !== null) results = results.filter(r => r.timestamp > since);
    return results.slice(-limit);
  } catch {
    return [];
  }
}

function getPendingCount() {
  return readNotifications(lastAck, 99999).length;
}

function sendHttpNotification(record) {
  const url = config.webhookUrl || process.env.SCHEDULER_WEBHOOK_URL;
  if (!url) return;
  try {
    const body = JSON.stringify(record);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, () => {});
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch {}
}

function resolveCommand(a) {
  if (a.script) {
    const ext = a.scriptType === 'python' ? '.py' : a.scriptType === 'powershell' ? '.ps1' : '.js';
    const runner = a.scriptType === 'python' ? 'python' : a.scriptType === 'powershell' ? 'powershell -ExecutionPolicy Bypass -File' : 'node';
    const scriptPath = path.join(SCRIPTS_DIR, a.id + ext);
    fs.writeFileSync(scriptPath, a.script, 'utf8');
    return { command: runner + ' \"' + scriptPath + '\"', cwd: a.cwd || process.cwd() };
  }
  return { command: a.command, cwd: a.cwd };
}

function resetState() {
  try { fs.unlinkSync(NOTIFICATIONS_FILE); } catch {}
  automationsMap.clear();
  tasksMap.clear();
  Object.keys(config).forEach(k => delete config[k]);
  lastAck = 0;
}

// ============================================================================
// Security validator
// ============================================================================

const DANGEROUS_PATTERNS = [];

const PROTECTED_CWD_PATTERNS = [];

function validateCommand(command) {
  if (!command) return { ok: true };
  const lower = command.toLowerCase();
  const dangerous = [
    'rm -rf /', 'rm -rf /*', 'rm -rf ~',
    'del /f /s /q', 'rmdir /s /q',
    'format ', 'diskpart', 'mkfs',
    'curl ', 'wget ', '| sh', '| bash', '| cmd', '| powershell',
    'shutdown /s', 'shutdown -h',
    'reg delete',
  ];
  for (const d of dangerous) {
    if (lower.includes(d)) return { ok: false, reason: 'Command blocked by security policy: dangerous pattern detected' };
  }
  return { ok: true };
}

function validateScript(script, scriptType) {
  if (!script) return { ok: true };
  const lower = script.toLowerCase();
  const dangerous = [
    'rm -rf /', 'rm -rf /*',
    'format ', 'diskpart', 'mkfs',
    'remove-item -recurse -force c:', 'remove-item -recurse -force c:\\',
    'format-volume', 'clear-disk', 'remove-computer',
    'fs.rmsync', 'fs.rmdirsync',
    'os.system', 'shutil.rmtree', 'subprocess.call',
    'dd if=/dev/zero',
    'curl ', 'wget ', '| sh', '| bash', '| cmd', '| powershell',
  ];
  for (const d of dangerous) {
    if (lower.includes(d)) return { ok: false, reason: 'Script blocked by security policy: dangerous pattern detected' };
  }
  return { ok: true };
}

function validateCwd(cwd) {
  if (!cwd) return { ok: true };
  const normalized = path.resolve(cwd).toLowerCase();
  const userHome = path.join(os.homedir()).toLowerCase();
  for (const pattern of PROTECTED_CWD_PATTERNS) {
    if (pattern.test(normalized)) {
      return { ok: false, reason: 'Working directory blocked by security policy: ' + normalized };
    }
  }
  const allowedRoots = [
    userHome,
    path.join(userHome, '.codex'),
    path.resolve('D:/repos').toLowerCase(),
    path.resolve('C:/temp').toLowerCase(),
    path.resolve('C:/tmp').toLowerCase(),
    path.join(userHome, 'documents').toLowerCase(),
    path.join(userHome, 'desktop').toLowerCase()
  ];
  const isAllowed = allowedRoots.some(root => normalized.startsWith(root));
  if (!isAllowed) {
    return { ok: false, reason: 'Working directory blocked by security policy: ' + normalized + '. Allowed roots: ' + allowedRoots.join(', ') };
  }
  return { ok: true };
}

function validateTask(args) {
  const cmdResult = validateCommand(args.command);
  if (!cmdResult.ok) return cmdResult;
  const scriptResult = validateScript(args.script, args.scriptType);
  if (!scriptResult.ok) return scriptResult;
  const cwdResult = validateCwd(args.cwd);
  if (!cwdResult.ok) return cwdResult;
  return { ok: true };
}

const api = {
  DATA_DIR, SCRIPTS_DIR, AUTOMATIONS_FILE, TASKS_FILE, NOTIFICATIONS_FILE, CONFIG_FILE, LAST_ACK_FILE,
  ensureDirs, loadState, resetState,
  getAutomation, addAutomation, removeAutomation, listAutomations,
  getTask, addTask, removeTask, listTasks,
  loadTemplates, listTemplates, getTemplate, interpolateTemplate,
  config,
  save, saveTasks, saveConfig, saveAck,
  appendNotification, readNotifications, getPendingCount,
  sendHttpNotification, resolveCommand,
  validateCommand, validateScript, validateCwd, validateTask
};

Object.defineProperty(api, 'lastAck', {
  get() { return lastAck; },
  set(v) { lastAck = v; }
});

module.exports = api;
