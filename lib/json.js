'use strict';

/**
 * JSON handling for the one field that does not survive a JavaScript round-trip.
 *
 * `runId` is an int64. Core generates it from the wall clock in nanoseconds, which
 * in 2026 is a 19-digit number — far beyond Number.MAX_SAFE_INTEGER (16 digits). A
 * plain JSON.parse silently rounds it, and the client then echoes back a value that
 * is close to, but not, the one Core sent.
 *
 * That failure is invisible from both ends. The heartbeat still succeeds, no error
 * is logged anywhere, and Core's log ingestion — which attaches lines by joining on
 * run_id — simply matches no execution and drops them, deliberately, so that stale
 * logs cannot fail a healthy heartbeat. The symptom is console output that never
 * appears, with nothing to explain why.
 *
 * So runId is carried as an exact decimal string everywhere inside this library and
 * spliced back into the payload as a bare JSON number. It is never used
 * arithmetically — only compared and echoed — so a string loses nothing.
 *
 * The two regexes below are safe against injection from log content: JSON escapes
 * any quote inside a string value, so the unescaped sequence `"runId":` can only
 * ever occur as a real key.
 */

const PARSE_RUN_ID = /"runId"\s*:\s*(-?\d+)/g;
const STRINGIFY_RUN_ID = /"runId":"(-?\d+)"/g;

/**
 * Parses a Core response, keeping every runId as an exact string.
 *
 * Returns null for an empty or unparseable body: a body that is not JSON is not a
 * transport failure, and the status still tells the caller what happened. Callers
 * that need to tell "no body" from "bad body" apart use readResponse().
 */
function parseResponse(text) {
  return readResponse(text).value;
}

/**
 * parseResponse, with the reason a body could not be read.
 *
 * A 2xx heartbeat whose body is empty or unparseable is a protocol failure rather
 * than a quiet success, and the caller has to be able to say which of the two it
 * was in the log line it emits.
 */
function readResponse(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { value: null, error: null, empty: true };
  }
  try {
    return {
      value: JSON.parse(text.replace(PARSE_RUN_ID, '"runId":"$1"')),
      error: null,
      empty: false
    };
  } catch (error) {
    return { value: null, error: error, empty: false };
  }
}

/**
 * Serialises a heartbeat payload, emitting runId as a number rather than a string.
 *
 * Core's DTO types it as *int64, and Go's encoding/json will not unmarshal a JSON
 * string into one, so sending the string form would be rejected outright.
 */
function stringifyPayload(payload) {
  return JSON.stringify(payload).replace(STRINGIFY_RUN_ID, '"runId":$1');
}

/**
 * Normalises whatever Core sent into an exact decimal string, or null.
 *
 * Accepts a string (the normal path), and a number for tolerance — a small runId
 * from a test double or an older Core round-trips through a JS number safely, and
 * refusing it would be gratuitous.
 */
function toRunId(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const text = value.trim();
    return /^-?\d+$/.test(text) && text !== '0' && text.charAt(0) !== '-' ? text : null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
    // Beyond this point the value has already lost precision upstream; there is
    // nothing to recover, but it is still the best token available.
    return String(value);
  }

  return null;
}

module.exports = { parseResponse, readResponse, stringifyPayload, toRunId };
