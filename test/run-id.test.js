'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseResponse, stringifyPayload, toRunId } = require('../lib/json');

/**
 * Core generates runId with Go's time.Now().UnixNano(): a 19-digit int64, well past
 * Number.MAX_SAFE_INTEGER. Every test here exists because getting this wrong is
 * invisible — the heartbeat still succeeds, and Core silently drops the console
 * output whose runId matches no execution.
 */
const CORE_RUN_ID = '1787928123456789012';

test('a Go-scale runId survives parsing without losing precision', function () {
  const body = parseResponse(
    '{"processes":[{"name":"p","desiredState":"running","desiredToken":1,' +
    '"runId":' + CORE_RUN_ID + '}]}'
  );
  assert.strictEqual(body.processes[0].runId, CORE_RUN_ID);
  // The reason this matters: a plain parse rounds it.
  assert.notStrictEqual(
    String(JSON.parse('{"r":' + CORE_RUN_ID + '}').r), CORE_RUN_ID
  );
});

test('a runId is serialised back as a JSON number, not a string', function () {
  // Core's DTO is *int64, and Go will not unmarshal a JSON string into one.
  const json = stringifyPayload({ processes: [{ name: 'p', runId: CORE_RUN_ID }] });
  assert.match(json, /"runId":1787928123456789012/);
  assert.doesNotMatch(json, /"runId":"/);
});

test('a runId round-trips through the client byte for byte', function () {
  const parsed = parseResponse('{"processes":[{"runId":' + CORE_RUN_ID + '}]}');
  const sent = stringifyPayload({ processes: [{ runId: parsed.processes[0].runId }] });
  const echoed = /"runId":(\d+)/.exec(sent)[1];
  assert.strictEqual(echoed, CORE_RUN_ID, 'Core must receive exactly what it sent');
});

test('a null runId stays null through both directions', function () {
  const body = parseResponse('{"processes":[{"name":"p","runId":null}]}');
  assert.strictEqual(body.processes[0].runId, null);
  assert.match(stringifyPayload({ runId: null }), /"runId":null/);
});

test('log content cannot forge a runId, because JSON escapes its quotes', function () {
  // A process printing raw JSON must not be able to corrupt the payload.
  const hostile = '{"runId":999}  and  "runId":"777"';
  const json = stringifyPayload({
    processes: [{ runId: CORE_RUN_ID }],
    logs: [{ message: hostile }]
  });

  const reparsed = JSON.parse(json);
  assert.strictEqual(reparsed.logs[0].message, hostile, 'the message survives intact');
  assert.strictEqual(
    String(reparsed.processes[0].runId).slice(0, 4), '1787',
    'the real runId is still the only unquoted one'
  );
  // Exactly one unescaped occurrence: the real field. A quote inside a JSON
  // string is written as \" , so the hostile text never produces the bare
  // sequence counted here.
  assert.strictEqual(json.split('"runId":').length - 1, 1);
});

test('toRunId normalises what Core may send', function () {
  assert.strictEqual(toRunId(CORE_RUN_ID), CORE_RUN_ID);
  assert.strictEqual(toRunId(42), '42', 'a small number from a test double is fine');
  assert.strictEqual(toRunId(null), null);
  assert.strictEqual(toRunId(undefined), null);
  assert.strictEqual(toRunId(0), null, 'Core rejects a runId of 0');
  assert.strictEqual(toRunId(-5), null);
  assert.strictEqual(toRunId('not-a-number'), null);
});

test('unknown fields still parse, with runId preserved alongside them', function () {
  const body = parseResponse(
    '{"processes":[{"name":"p","runId":' + CORE_RUN_ID + ',"newField":{"a":[1,2]}}],' +
    '"serverVersion":"9.9.9"}'
  );
  assert.strictEqual(body.processes[0].runId, CORE_RUN_ID);
  assert.strictEqual(body.serverVersion, '9.9.9');
});
