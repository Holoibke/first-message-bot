'use strict';

/**
 * Tiny dependency-free logger with level filtering.
 * Levels: error < warn < info < debug
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = 'info';

function setLevel(level) {
  if (typeof level === 'string' && level.toLowerCase() in LEVELS) {
    currentLevel = level.toLowerCase();
  }
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, args) {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(`[${timestamp()}] ${level.toUpperCase().padEnd(5)} ${args.map(stringify).join(' ')}`);
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  setLevel,
  getLevel: () => currentLevel,
  error: (...args) => write('error', args),
  warn: (...args) => write('warn', args),
  info: (...args) => write('info', args),
  debug: (...args) => write('debug', args),
};
