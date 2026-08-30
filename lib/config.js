'use strict';

const os = require('os');
const { SynapsysConfigError } = require('./errors');
const { parseDuration, parseWholeSeconds } = require('./duration');
const { LEVELS, LEVEL_NAMES } = require('./logger');

/**
 * The complete set of options, with the environment variable each falls back to.
 *
 * The canonical name of a setting is its kebab-case form (`synapsys.core-url`); the
 * camelCase key and the SYNAPSYS_ environment variable are transliterations of it.
 */
const OPTIONS = {
  enabled:           { env: 'SYNAPSYS_ENABLED',            kind: 'boolean',  default: true },
  coreUrl:           { env: 'SYNAPSYS_CORE_URL',           kind: 'string',   default: null },
  coreToken:         { env: 'SYNAPSYS_CORE_TOKEN',         kind: 'string',   default: null },
  workerName:        { env: 'SYNAPSYS_WORKER_NAME',        kind: 'string',   default: null },
  host:              { env: 'SYNAPSYS_HOST',               kind: 'string',   default: null },
  heartbeatInterval: { env: 'SYNAPSYS_HEARTBEAT_INTERVAL', kind: 'seconds',  default: '5s' },
  failFast:          { env: 'SYNAPSYS_FAIL_FAST',          kind: 'boolean',  default: false },
  connectTimeout:    { env: 'SYNAPSYS_CONNECT_TIMEOUT',    kind: 'duration', default: '2s' },
  requestTimeout:    { env: 'SYNAPSYS_REQUEST_TIMEOUT',    kind: 'duration', default: '5s' },
  shutdownTimeout:   { env: 'SYNAPSYS_SHUTDOWN_TIMEOUT',   kind: 'duration', default: '10s' },
  captureConsole:    { env: 'SYNAPSYS_CAPTURE_CONSOLE',    kind: 'boolean',  default: true },
  logLevel:          { env: 'SYNAPSYS_LOG_LEVEL',          kind: 'level',    default: 'info' },
  logger:            { env: null,                          kind: 'logger',   default: null }
};

const KNOWN_KEYS = Object.keys(OPTIONS);

/**
 * Resolves and validates the options object.
 *
 * Plain JavaScript ignores an unknown object key in silence, so a typo such as
 * `heratBeatinterval` would leave the worker running on defaults forever with no
 * indication why. The Spring starter fails startup on the same mistake via
 * `ignoreUnknownFields = false`; this is the equivalent, and it runs even when
 * `enabled` is false, because a test suite is exactly where the typo would hide.
 */
function resolveConfig(options, env) {
  const source = options === undefined || options === null ? {} : options;
  const environment = env || process.env;

  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new SynapsysConfigError(
      'Options must be an object. Got ' +
      (Array.isArray(source) ? 'an array' : typeof source) + '.'
    );
  }

  rejectUnknownKeys(source, KNOWN_KEYS, 'Synapsys options');

  const config = {};
  for (const key of KNOWN_KEYS) {
    const spec = OPTIONS[key];
    if (has(source, key) && source[key] !== undefined) {
      config[key] = coerce(key, spec.kind, source[key], false);
      continue;
    }
    const fromEnv = spec.env ? environment[spec.env] : undefined;
    if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
      config[key] = coerce(spec.env, spec.kind, fromEnv, true);
      continue;
    }
    config[key] = spec.default === null ? null : coerce(key, spec.kind, spec.default, false);
  }

  // The machine hostname is the default, and null is allowed: Core then falls back
  // to the connection's remote address.
  if (config.host === null) config.host = resolveHostname();

  return Object.freeze(config);
}

/**
 * The checks that only make sense when the library is going to talk to Core. Kept
 * apart from resolveConfig so that `enabled: false` demands no Core configuration at
 * all, while a typo in any key still fails immediately.
 *
 * Returns the warnings to emit; throws only for what cannot be worked around.
 */
function validateForStartup(config) {
  const warnings = [];

  if (!config.coreUrl) {
    throw new SynapsysConfigError(
      "Missing 'coreUrl'. Set it in the options object or as SYNAPSYS_CORE_URL."
    );
  }

  let parsed;
  try {
    parsed = new URL(config.coreUrl);
  } catch (_) {
    throw new SynapsysConfigError(
      "'coreUrl' is not a valid URL: " + JSON.stringify(config.coreUrl) + '.'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SynapsysConfigError(
      "'coreUrl' must be an http or https URL. Got " + JSON.stringify(config.coreUrl) + '.'
    );
  }

  if (!config.workerName || String(config.workerName).trim() === '') {
    throw new SynapsysConfigError(
      "Missing 'workerName'. Set it in the options object or as SYNAPSYS_WORKER_NAME. " +
      'It is this worker identity across restarts, so it has no safe default.'
    );
  }

  if (!config.coreToken) {
    warnings.push("Missing 'coreToken' | Core will reject worker heartbeats");
  } else if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    // A bearer token over plaintext HTTP is a credential leak, and the user has
    // usually not noticed.
    warnings.push(
      'Core URL uses plaintext http and a token is set | the bearer token is sent ' +
      'in clear text to ' + parsed.host
    );
  }

  return warnings;
}

/** Shared by the options object and the per-process registration options. */
function rejectUnknownKeys(object, known, what) {
  const unknown = Object.keys(object).filter(function (key) {
    return known.indexOf(key) === -1;
  });
  if (unknown.length === 0) return;
  throw new SynapsysConfigError(
    'Unknown ' + what + ': ' + unknown.map(quote).join(', ') + '. ' +
    'Expected any of: ' + known.map(quote).join(', ') + '.'
  );
}

function coerce(name, kind, value, fromEnv) {
  switch (kind) {
    case 'boolean':  return toBoolean(name, value, fromEnv);
    case 'string':   return toTrimmedString(name, value);
    case 'duration': return parseDuration(value, name);
    case 'seconds':  return parseWholeSeconds(value, name);
    case 'level':    return toLevel(name, value);
    case 'logger':   return toLogger(name, value);
    default:         return value;
  }
}

function toBoolean(name, value, fromEnv) {
  if (typeof value === 'boolean') return value;
  if (fromEnv || typeof value === 'string') {
    const text = String(value).trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  }
  throw new SynapsysConfigError(
    "'" + name + "' must be true or false. Got " + JSON.stringify(value) + '.'
  );
}

function toTrimmedString(name, value) {
  if (typeof value !== 'string') {
    throw new SynapsysConfigError(
      "'" + name + "' must be a string. Got " +
      (value === null ? 'null' : typeof value) + '.'
    );
  }
  const text = value.trim();
  return text === '' ? null : text;
}

function toLevel(name, value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (typeof text !== 'string' || !Object.prototype.hasOwnProperty.call(LEVELS, text)) {
    throw new SynapsysConfigError(
      "'" + name + "' must be one of: " + LEVEL_NAMES.map(quote).join(', ') +
      '. Got ' + JSON.stringify(value) + '.'
    );
  }
  return text;
}

function toLogger(name, value) {
  if (value === null) return null;
  if (typeof value !== 'object') {
    throw new SynapsysConfigError(
      "'" + name + "' must be an object with debug, info, warn and error methods. Got " +
      typeof value + '.'
    );
  }
  const missing = ['debug', 'info', 'warn', 'error'].filter(function (level) {
    return typeof value[level] !== 'function';
  });
  if (missing.length > 0) {
    throw new SynapsysConfigError(
      "'" + name + "' is missing method(s): " + missing.map(quote).join(', ') +
      '. A logger must provide debug, info, warn and error.'
    );
  }
  return value;
}

function resolveHostname() {
  try {
    const name = os.hostname();
    return name && name.trim() !== '' ? name : null;
  } catch (_) {
    return null;
  }
}

function isLoopback(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' ||
    /^127\./.test(host) || /\.localhost$/.test(host);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function quote(value) {
  return "'" + value + "'";
}

module.exports = {
  resolveConfig,
  validateForStartup,
  rejectUnknownKeys,
  KNOWN_KEYS,
  OPTIONS
};
