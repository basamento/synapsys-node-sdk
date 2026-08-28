'use strict';

const { Synapsys } = require('./lib/synapsys');
const { StopSignal } = require('./lib/stop-signal');
const {
  SynapsysConfigError,
  SynapsysError,
  StopRequested
} = require('./lib/errors');

module.exports = {
  Synapsys: Synapsys,
  StopSignal: StopSignal,
  SynapsysConfigError: SynapsysConfigError,
  SynapsysError: SynapsysError,
  StopRequested: StopRequested
};
