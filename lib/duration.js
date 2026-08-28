'use strict';

const { SynapsysConfigError } = require('./errors');

const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000 };
const PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/;

/**
 * Parses a duration to milliseconds.
 *
 * Durations carry units across every Synapsys client library: '30s', '5m', '250ms',
 * '2h'. A plain number is accepted as milliseconds, but the documented form has a
 * unit, because '30' reads as seconds to about half the people who write it.
 */
function parseDuration(value, settingName) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new SynapsysConfigError(
        "'" + settingName + "' as a number must be a whole, non-negative count of " +
        'milliseconds. Got ' + value + '.'
      );
    }
    return value;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    const match = PATTERN.exec(text);
    if (!match) {
      if (/^\d+(\.\d+)?$/.test(text)) {
        throw new SynapsysConfigError(
          "'" + settingName + "' must carry a unit. Write '" + text + "s' for seconds " +
          "or '" + text + "ms' for milliseconds, or pass the number " + text +
          ' to mean milliseconds. Got "' + value + '".'
        );
      }
      throw new SynapsysConfigError(
        "'" + settingName + "' must be a duration with a unit of ms, s, m or h — for " +
        "example '30s', '5m', '250ms' or '2h' — or a whole number of milliseconds. " +
        'Got "' + value + '".'
      );
    }
    const milliseconds = Number(match[1]) * UNITS[match[2]];
    if (!Number.isInteger(milliseconds)) {
      throw new SynapsysConfigError(
        "'" + settingName + "' must resolve to a whole number of milliseconds. " +
        '"' + text + '" is ' + milliseconds + 'ms.'
      );
    }
    return milliseconds;
  }

  throw new SynapsysConfigError(
    "'" + settingName + "' must be a duration string such as '30s', or a whole number " +
    'of milliseconds. Got ' + describe(value) + '.'
  );
}

/**
 * Parses a duration that the wire protocol requires to be whole seconds.
 * heartbeatInterval is sent to Core as an integer, so '1500ms' has no representation
 * and is a startup failure rather than a silent rounding.
 */
function parseWholeSeconds(value, settingName) {
  const milliseconds = parseDuration(value, settingName);
  if (milliseconds <= 0 || milliseconds % 1000 !== 0) {
    throw new SynapsysConfigError(
      "'" + settingName + "' must be a positive whole number of seconds — Core " +
      'accepts an integer count of seconds and nothing else. Got ' +
      formatDuration(milliseconds) + '.'
    );
  }
  return milliseconds;
}

/** Renders milliseconds back into the shortest exact unit, for the startup echo. */
function formatDuration(milliseconds) {
  if (milliseconds === 0) return '0ms';
  if (milliseconds % UNITS.h === 0) return milliseconds / UNITS.h + 'h';
  if (milliseconds % UNITS.m === 0) return milliseconds / UNITS.m + 'm';
  if (milliseconds % UNITS.s === 0) return milliseconds / UNITS.s + 's';
  return milliseconds + 'ms';
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return 'a value of type ' + typeof value;
}

module.exports = { parseDuration, parseWholeSeconds, formatDuration };
