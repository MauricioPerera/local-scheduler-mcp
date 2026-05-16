
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = require("zod/v4");

const {
  ensureDirs, loadState, resetState,
  automations, tasks, config, lastAck,
  save, saveTasks, saveConfig, saveAck,
  appendNotification, readNotifications, getPendingCount,
  sendHttpNotification, resolveCommand, validateTask,
  DATA_DIR, SCRIPTS_DIR
} = require('./lib.js');

ensureDirs();
loadState();

const TASK_ALLOWED = { execution: { taskSupport: 'allowed' } };

const server = new McpServer(
  { name: 'local-scheduler', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

function notifyCompletion(notification) {
  appendNotification(notification);
  sendHttpNotification(notification);
  try {
    server.sendLoggingMessage({ level: 'info', data: notification });
  } catch {}
}

server.tool('create_automation', 'Create a recurring automation. Use \"command\" for a shell command, or \"script\" + \"scriptType\" for inline code.', {
  name: z.string().describe('Automation name'),
  intervalMinutes: z.number().describe('Interval in minutes'),
  cwd: z.string().optional().describe('Working directory (default: user home)'),
  command: z.string().optional().describe('Shell command to run. Use this OR script, not both.'),
  script: z.string().optional().describe('Inline code to execute. Use this OR command, not both.'),
  scriptType: z.enum(['javascript', 'python', 'powershell']).optional().describe('Language of inline script. Default: javascript'),
  model: z.string().optional().describe('Model to use'),
  reasoningEffort: z.string().optional().describe('Reasoning effort')
}, TASK_ALLOWED, async (args) => {
  const v = validateTask(args);
  if (!v.ok) {
    return { content: [{ type: 'text', text: 'Security error: ' + v.reason }], isError: true };
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  if (!args.command && !args.script) {
    return { content: [{ type: 'text', text: 'Error: provide either \"command\" or \"script\"' }], isError: true };
  }
  if (args.script) {
    const ext = args.scriptType === 'python' ? '.py' : args.scriptType === 'powershell' ? '.ps1' : '.js';
    fs.writeFileSync(path.join(SCRIPTS_DIR, id + ext), args.script, 'utf8');
  }
  automations.push({
    id, name: args.name, intervalMinutes: args.intervalMinutes,
    cwd: args.cwd || path.join(require('os').homedir(), '.codex'),
    command: args.command || null,
    script: args.script || null,
    scriptType: args.scriptType || 'javascript',
    model: args.model || null,
    reasoningEffort: args.reasoningEffort || null,
    nextRun: Date.now(), logs: []
  });
  save();
  return { content: [{ type: 'text', text: 'Created automation ' + id }] };
});

server.tool('list_automations', 'List all automations with pending notification counts', {}, TASK_ALLOWED, async () => {
  const pending = getPendingCount();
  const list = automations.map(a => ({
    id: a.id,
    name: a.name,
    intervalMinutes: a.intervalMinutes,
    cwd: a.cwd,
    command: a.command,
    hasScript: !!a.script,
    scriptType: a.scriptType,
    nextRun: new Date(a.nextRun).toISOString(),
    lastLog: a.logs.length > 0 ? a.logs[a.logs.length - 1] : null
  }));
  return { content: [{ type: 'text', text: 'Pending notifications: ' + pending + '\n\n' + JSON.stringify(list, null, 2) }] };
});

server.tool('delete_automation', 'Delete an automation', {
  id: z.string().describe('Automation ID')
}, TASK_ALLOWED, async (args) => {
  const a = automations.find(x => x.id === args.id);
  if (a && a.script) {
    const ext = a.scriptType === 'python' ? '.py' : a.scriptType === 'powershell' ? '.ps1' : '.js';
    const scriptPath = path.join(SCRIPTS_DIR, a.id + ext);
    try { fs.unlinkSync(scriptPath); } catch {}
  }
  const before = automations.length;
  const idxA = automations.findIndex(a => a.id === args.id);
  if (idxA !== -1) automations.splice(idxA, 1);
  save();
  return { content: [{ type: 'text', text: automations.length < before ? 'Deleted' : 'Not found' }] };
});

server.tool('get_automation_logs', 'Get run logs', {
  id: z.string().describe('Automation ID'),
  limit: z.number().optional().describe('Max logs to return')
}, TASK_ALLOWED, async (args) => {
  const a = automations.find(x => x.id === args.id);
  const logs = a ? a.logs.slice(-(args.limit || 10)) : [];
  return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
});

server.tool('check_notifications', 'Check pending notifications since last ack or a timestamp', {
  since: z.string().optional().describe('ISO timestamp to filter from (overrides last ack)'),
  limit: z.number().optional().describe('Max notifications to return')
}, TASK_ALLOWED, async (args) => {
  const since = args.since ? new Date(args.since).getTime() : lastAck;
  const notifs = readNotifications(since, args.limit || 50);
  return { content: [{ type: 'text', text: JSON.stringify(notifs, null, 2) }] };
});

server.tool('ack_notifications', 'Acknowledge all notifications up to a timestamp', {
  upTo: z.string().describe('Acknowledge all notifications up to this ISO timestamp')
}, TASK_ALLOWED, async (args) => {
  const ts = new Date(args.upTo).getTime();
  if (ts > lastAck) {
    lastAck = ts;
    saveAck();
  }
  return { content: [{ type: 'text', text: 'Acknowledged up to ' + args.upTo + '. Remaining pending: ' + getPendingCount() }] };
});

server.tool('set_webhook', 'Set a webhook URL for push notifications', {
  url: z.string().describe('Webhook URL')
}, TASK_ALLOWED, async (args) => {
  config.webhookUrl = args.url;
  saveConfig();
  return { content: [{ type: 'text', text: 'Webhook set to ' + args.url }] };
});

server.tool('get_pending_summary', 'Get a one-line summary of pending notifications for quick status checks', {}, TASK_ALLOWED, async () => {
  const pending = getPendingCount();
  const notifs = readNotifications(lastAck, 10);
  const byAutomation = {};
  for (const n of notifs) {
    const name = n.automationName || n.taskName; byAutomation[name] = (byAutomation[name] || 0) + 1;
  }
  const summary = Object.entries(byAutomation).map(([name, count]) => name + ': ' + count).join('; ');
  return { content: [{ type: 'text', text: pending + ' pending notifications. ' + (summary || 'None') }] };
});

// One-shot long tasks
server.tool('run_task', 'Run a one-shot background task and return a taskId immediately. Check status later with get_task_status.', {
  name: z.string().describe('Task name'),
  cwd: z.string().optional().describe('Working directory (default: user home)'),
  command: z.string().optional().describe('Shell command to run. Use this OR script, not both.'),
  script: z.string().optional().describe('Inline code to execute. Use this OR command, not both.'),
  scriptType: z.enum(['javascript', 'python', 'powershell']).optional().describe('Language of inline script. Default: javascript'),
  timeoutMs: z.number().optional().describe('Timeout in milliseconds (default: 300000 = 5 min)')
}, TASK_ALLOWED, async (args) => {
  const v = validateTask(args);
  if (!v.ok) {
    return { content: [{ type: 'text', text: 'Security error: ' + v.reason }], isError: true };
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  if (!args.command && !args.script) {
    return { content: [{ type: 'text', text: 'Error: provide either \"command\" or \"script\"' }], isError: true };
  }
  if (args.script) {
    const ext = args.scriptType === 'python' ? '.py' : args.scriptType === 'powershell' ? '.ps1' : '.js';
    fs.writeFileSync(path.join(SCRIPTS_DIR, id + ext), args.script, 'utf8');
  }
  const task = {
    id, name: args.name,
    cwd: args.cwd || path.join(require('os').homedir(), '.codex'),
    command: args.command || null,
    script: args.script || null,
    scriptType: args.scriptType || 'javascript',
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    stdout: '',
    stderr: ''
  };
  tasks.push(task);
  saveTasks();
  const { command, cwd } = resolveCommand(task);
  exec(command, { cwd, timeout: args.timeoutMs || 300000 }, (error, stdout, stderr) => {
    task.status = error ? 'failed' : 'completed';
    task.completedAt = new Date().toISOString();
    task.exitCode = error ? (error.code || -1) : 0;
    task.stdout = stdout || '';
    task.stderr = stderr || '';
    saveTasks();
    const notification = {
      type: 'task_run',
      taskId: id,
      taskName: task.name,
      timestamp: Date.now(),
      result: { status: task.status, exitCode: task.exitCode }
    };
    notifyCompletion(notification);
  });
  return { content: [{ type: 'text', text: 'Task ' + id + ' started. Use get_task_status with id=' + id + ' to check progress.' }] };
});

server.tool('get_task_status', 'Get the current status and output of a one-shot task', {
  id: z.string().describe('Task ID')
}, TASK_ALLOWED, async (args) => {
  const task = tasks.find(t => t.id === args.id);
  if (!task) {
    return { content: [{ type: 'text', text: 'Task not found: ' + args.id }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
});

server.tool('list_tasks', 'List all one-shot tasks ordered by most recent', {}, TASK_ALLOWED, async () => {
  const list = tasks.slice().reverse().map(t => ({
    id: t.id,
    name: t.name,
    status: t.status,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    exitCode: t.exitCode
  }));
  return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
});

server.tool('delete_task', 'Delete a one-shot task and its script file', {
  id: z.string().describe('Task ID')
}, TASK_ALLOWED, async (args) => {
  const t = tasks.find(x => x.id === args.id);
  if (t && t.script) {
    const ext = t.scriptType === 'python' ? '.py' : t.scriptType === 'powershell' ? '.ps1' : '.js';
    const scriptPath = path.join(SCRIPTS_DIR, t.id + ext);
    try { fs.unlinkSync(scriptPath); } catch {}
  }
  const before = tasks.length;
  const idxT = tasks.findIndex(t => t.id === args.id);
  if (idxT !== -1) tasks.splice(idxT, 1);
  saveTasks();
  return { content: [{ type: 'text', text: tasks.length < before ? 'Deleted' : 'Not found' }] };
});

// Scheduler tick every 30s
setInterval(() => {
  const now = Date.now();
  for (const a of automations) {
    if (now >= a.nextRun) {
      a.nextRun = now + a.intervalMinutes * 60 * 1000;
      save();
      const { command, cwd } = resolveCommand(a);
      exec(command, { cwd, timeout: 120000 }, (error, stdout, stderr) => {
        const log = { time: new Date().toISOString(), exitCode: error ? (error.code || -1) : 0, stdout: stdout || '', stderr: stderr || '' };
        a.logs.push(log);
        if (a.logs.length > 100) a.logs.shift();
        save();
        const notification = {
          type: 'automation_run',
          automationId: a.id,
          automationName: a.name,
          timestamp: Date.now(),
          result: log
        };
        notifyCompletion(notification);
      });
    }
  }
}, 30000);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error('Local Scheduler MCP v3.0.0 started on stdio');
});
