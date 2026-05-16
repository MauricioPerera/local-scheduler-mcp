
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

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

let automations = [];
let tasks = [];
let config = {};
let lastAck = 0;

function loadState() {
  if (fs.existsSync(AUTOMATIONS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8'));
      automations.length = 0;
      automations.push(...data);
    } catch {}
  }
  if (fs.existsSync(TASKS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      tasks.length = 0;
      tasks.push(...data);
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

function save() {
  fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(automations, null, 2));
}

function saveTasks() {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function saveAck() {
  fs.writeFileSync(LAST_ACK_FILE, JSON.stringify({ timestamp: lastAck }, null, 2));
}

function appendNotification(record) {
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(NOTIFICATIONS_FILE, line);
}

function readNotifications(since = null, limit = 50) {
  if (!fs.existsSync(NOTIFICATIONS_FILE)) return [];
  const lines = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8').split('\n').filter(Boolean);
  let results = lines.map(l => JSON.parse(l));
  if (since) results = results.filter(r => r.timestamp > since);
  return results.slice(-limit);
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
  automations.length = 0;
  tasks.length = 0;
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
  automations, tasks, config,
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
