'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveConfig, validateForStartup } = require('../lib/config');
const { parseDuration, parseWholeSeconds, formatDuration } = require('../lib/duration');
const { Synapsys, SynapsysConfigError } = require('../index.js');

test('an unknown option throws, naming what was passed and what was expected', function () {
  assert.throws(
    function () { new Synapsys({ workerName: 'w', heratBeatinterval: '5s' }); },
    function (error) {
      assert.ok(error instanceof SynapsysConfigError);
      assert.match(error.message, /^\[Synapsys\] /);
      assert.match(error.message, /'heratBeatinterval'/);
      assert.match(error.message, /'heartbeatInterval'/);
      return true;
    }
  );
});

test('unknown options are rejected even when disabled, where the typo would hide', function () {
  assert.throws(
    function () { new Synapsys({ enabled: false, corUrl: 'http://x' }); },
    /'corUrl'/
  );
});

test('an unknown per-process option throws', function () {
  const synapsys = new Synapsys({ enabled: false, workerName: 'w' });
  assert.throws(
    function () { synapsys.endless('p', function () {}, { onstop: function () {} }); },
    /'onstop'/
  );
});

test('durations carry units, and a unitless string is refused with guidance', function () {
  assert.strictEqual(parseDuration('30s', 'x'), 30000);
  assert.strictEqual(parseDuration('5m', 'x'), 300000);
  assert.strictEqual(parseDuration('250ms', 'x'), 250);
  assert.strictEqual(parseDuration('2h', 'x'), 7200000);
  assert.strictEqual(parseDuration(1500, 'x'), 1500);

  assert.throws(function () { parseDuration('30', 'x'); }, /must carry a unit/);
  assert.throws(function () { parseDuration('30 seconds', 'x'); }, /unit of ms, s, m or h/);
  assert.throws(function () { parseDuration(-1, 'x'); }, /non-negative/);
  assert.throws(function () { parseDuration(1.5, 'x'); }, /whole/);
});

test('heartbeatInterval must be whole seconds, because the wire format is an integer', function () {
  assert.strictEqual(parseWholeSeconds('5s', 'x'), 5000);
  assert.throws(function () { parseWholeSeconds('1500ms', 'x'); }, /whole number of seconds/);
  assert.throws(function () { parseWholeSeconds('0s', 'x'); }, /positive/);
});

test('formatDuration renders the shortest exact unit', function () {
  assert.strictEqual(formatDuration(5000), '5s');
  assert.strictEqual(formatDuration(300000), '5m');
  assert.strictEqual(formatDuration(250), '250ms');
});

test('environment variables fill in what the options object omits', function () {
  const config = resolveConfig({ workerName: 'w' }, {
    SYNAPSYS_CORE_URL: 'https://core.example.com',
    SYNAPSYS_CORE_TOKEN: 'secret',
    SYNAPSYS_HEARTBEAT_INTERVAL: '10s',
    SYNAPSYS_FAIL_FAST: 'true'
  });
  assert.strictEqual(config.coreUrl, 'https://core.example.com');
  assert.strictEqual(config.heartbeatInterval, 10000);
  assert.strictEqual(config.failFast, true);
});

test('options win over the environment', function () {
  const config = resolveConfig(
    { workerName: 'w', coreUrl: 'https://from-options' },
    { SYNAPSYS_CORE_URL: 'https://from-env' }
  );
  assert.strictEqual(config.coreUrl, 'https://from-options');
});

test('defaults match the specification', function () {
  const config = resolveConfig({}, {});
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.heartbeatInterval, 5000);
  assert.strictEqual(config.connectTimeout, 2000);
  assert.strictEqual(config.requestTimeout, 5000);
  assert.strictEqual(config.failFast, false);
  assert.strictEqual(config.captureConsole, true);
  assert.strictEqual(config.logLevel, 'info');
});

test('startup validation demands a core URL and a worker name', function () {
  assert.throws(
    function () { validateForStartup(resolveConfig({ workerName: 'w' }, {})); },
    /Missing 'coreUrl'/
  );
  assert.throws(
    function () {
      validateForStartup(resolveConfig({ coreUrl: 'https://c' }, {}));
    },
    /Missing 'workerName'/
  );
});

test('a missing token warns rather than failing', function () {
  const warnings = validateForStartup(
    resolveConfig({ coreUrl: 'https://c', workerName: 'w' }, {})
  );
  assert.ok(warnings.some(function (w) { return /Missing 'coreToken'/.test(w); }));
});

test('a token over plaintext http to a remote host warns', function () {
  const warnings = validateForStartup(
    resolveConfig({ coreUrl: 'http://core.example.com', workerName: 'w', coreToken: 't' }, {})
  );
  assert.ok(warnings.some(function (w) { return /plaintext http/.test(w); }));
});

test('a token over plaintext http to loopback does not warn', function () {
  const warnings = validateForStartup(
    resolveConfig({ coreUrl: 'http://127.0.0.1:8080', workerName: 'w', coreToken: 't' }, {})
  );
  assert.strictEqual(warnings.length, 0);
});

test('the resolved config never exposes the token', function () {
  const synapsys = new Synapsys({
    enabled: false, workerName: 'w', coreUrl: 'https://c', coreToken: 'super-secret'
  });
  assert.strictEqual(JSON.stringify(synapsys.config).indexOf('super-secret'), -1);
});

test('a duplicate process name is a registration failure, not a warning', function () {
  const synapsys = new Synapsys({ enabled: false, workerName: 'w' });
  synapsys.endless('dup', function () {});
  assert.throws(function () { synapsys.progressive('dup', function () {}); }, /Duplicate process name/);
});

test('a named function supplies its own process name', function () {
  const synapsys = new Synapsys({ enabled: false, workerName: 'w' });
  function pollInvoices() {}
  synapsys.endless(pollInvoices);
  assert.strictEqual(synapsys.processes[0].name, 'pollInvoices');
});

test('registering without a usable name fails', function () {
  const synapsys = new Synapsys({ enabled: false, workerName: 'w' });
  assert.throws(function () { synapsys.endless(function () {}); }, /needs a process name/);
  assert.throws(function () { synapsys.endless('x'); }, /needs a function/);
});
