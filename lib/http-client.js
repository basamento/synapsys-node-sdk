'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** A pathological response must not be read into memory without a bound. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * The HTTP client, built on node:http and node:https rather than fetch.
 *
 * fetch follows redirects by default, and a redirect would forward the
 * Authorization header to another host; it also offers no connect timeout distinct
 * from the overall request timeout. node:http follows nothing and exposes the
 * socket, so both requirements are met with no dependency.
 */
class HttpClient {
  constructor(options) {
    this._connectTimeout = options.connectTimeout;
    this._requestTimeout = options.requestTimeout;
    // Held privately and only ever written into the Authorization header. It is
    // never logged, never placed in a URL, and never included in an error message.
    this._token = options.coreToken || null;
    this._agents = {
      'http:': new http.Agent({ keepAlive: true, maxSockets: 4 }),
      'https:': new https.Agent({ keepAlive: true, maxSockets: 4 })
    };
  }

  /**
   * Sends a request and resolves with the status and parsed body. Rejects only on
   * transport failure; a non-2xx status resolves, because the caller distinguishes
   * "could not reach Core" from "Core said no".
   */
  request(method, urlString, body) {
    const self = this;
    return new Promise(function (resolve, reject) {
      let url;
      try {
        url = new URL(urlString);
      } catch (error) {
        reject(error);
        return;
      }

      const transport = url.protocol === 'https:' ? https : http;
      const payload = body === undefined || body === null
        ? null
        : Buffer.from(JSON.stringify(body), 'utf8');

      const headers = { Accept: 'application/json' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      if (self._token) headers.Authorization = 'Bearer ' + self._token;

      const request = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: method,
        headers: headers,
        agent: self._agents[url.protocol]
        // No redirect handling: node:http never follows one, which is what we want.
        // A 3xx surfaces as a non-2xx status and is treated as Core being
        // unavailable, rather than replaying the bearer token at a new host.
      });

      let settled = false;
      let connected = false;

      // Startup never hangs, and a wedged Core never stalls the loop: a connect
      // timeout and a whole-request timeout, both always set.
      const connectTimer = setTimeout(function () {
        if (!connected) fail(timeoutError('connect', self._connectTimeout, url));
      }, self._connectTimeout);

      const requestTimer = setTimeout(function () {
        fail(timeoutError('request', self._requestTimeout, url));
      }, self._requestTimeout);

      function cleanup() {
        clearTimeout(connectTimer);
        clearTimeout(requestTimer);
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        request.destroy();
        reject(error);
      }

      function succeed(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }

      request.on('socket', function (socket) {
        if (socket.connecting === false) {
          connected = true;
          clearTimeout(connectTimer);
          return;
        }
        socket.once('connect', function () {
          connected = true;
          clearTimeout(connectTimer);
        });
      });

      request.on('error', function (error) { fail(error); });

      request.on('response', function (response) {
        const chunks = [];
        let length = 0;
        response.on('data', function (chunk) {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy();
            fail(new Error('Core response exceeded ' + MAX_RESPONSE_BYTES + ' bytes'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text.trim() !== '') {
            try {
              parsed = JSON.parse(text);
            } catch (_) {
              // A body that is not JSON is not a transport failure. The status
              // still tells the caller what happened.
              parsed = null;
            }
          }
          succeed({ status: response.statusCode, body: parsed });
        });
        response.on('error', function (error) { fail(error); });
      });

      if (payload) request.write(payload);
      request.end();
    });
  }

  close() {
    for (const key of Object.keys(this._agents)) {
      try {
        this._agents[key].destroy();
      } catch (_) {
        // Shutdown is non-throwing.
      }
    }
  }
}

/** The URL is included without its query string, and the token never appears in it. */
function timeoutError(kind, milliseconds, url) {
  const error = new Error(
    kind.charAt(0).toUpperCase() + kind.slice(1) + ' timeout after ' + milliseconds +
    'ms for ' + url.protocol + '//' + url.host + url.pathname
  );
  error.code = kind === 'connect' ? 'ETIMEDOUT_CONNECT' : 'ETIMEDOUT_REQUEST';
  return error;
}

module.exports = { HttpClient };
