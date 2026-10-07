'use strict';

const fs = require('fs');
const path = require('path');
const { parseJsonc } = require('./jsonc');


const DEFAULTS = {
  // --- credentials -------------------------------------------------------
  token: '', // leave empty to read it from the environment / .env instead
  tokenEnvVar: 'DISCORD_TOKEN',

  // --- where the bot is active -------------------------------------------
  guilds: [], // empty = every server the bot is in
  channels: [], // empty = every channel; names, #names, IDs or category names
  ignoreChannels: [], // always wins over `channels`

  // --- who is ignored -----------------------------------------------------
  ignoreUsers: [],
  ignoreRoles: [],
  ignoreBots: true,

  // --- who counts as "new" ------------------------------------------------
  onlyForRecentJoiners: { enabled: false, withinMinutes: 60 },
  seedExistingMembersOnFirstRun: false,

  // --- what gets sent -----------------------------------------------------
  message: 'who the fuck are you',
  mentionUser: true,
  allowEveryoneMention: false,
  replyToMessage: false,
  deleteAfterSeconds: 0,
  deleteTriggerMessage: false,
  embed: {
    enabled: false,
    color: '#5865F2',
    title: '',
    description: '',
    thumbnail: '{avatar}',
    image: '',
    footer: '',
    fields: [], // [{ "name": "Account age", "value": "{accountAge}", "inline": true }]
  },

  // --- performance --------------------------------------------------------
  cache: {
    messagesPerChannel: 5, // this bot never reads message history
    members: 0, // 0 = keep every member in memory (default); set a number on huge servers
  },

  // --- plumbing -----------------------------------------------------------
  dryRun: false,
  dataFile: 'data/state.json',
  logLevel: 'info',
  resetCommand: { enabled: true, trigger: '!firstmsg-reset' },
};

const ID_LIKE = /^\d{15,25}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDotEnv(file) {
  const result = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function normalizeList(value, key, warnings) {
  if (value === undefined || value === null) return [];
  let list = value;
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list)) {
    warnings.push(`"${key}" must be a list (or omit it) — ignoring it.`);
    return [];
  }
  const out = [];
  for (const entry of list) {
    if (typeof entry === 'number') {
      warnings.push(
        `"${key}" contains the number ${entry} — Discord IDs must be quoted strings ("${entry}"), ` +
          'otherwise long IDs lose precision.',
      );
      out.push(String(entry));
      continue;
    }
    if (typeof entry !== 'string') {
      warnings.push(`"${key}" contains a non-string entry (${typeof entry}) — skipping it.`);
      continue;
    }
    const cleaned = entry.trim().replace(/^#/, '');
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function normalizeRecentJoiners(value, warnings) {
  const defaults = { ...DEFAULTS.onlyForRecentJoiners };
  if (value === undefined || value === null) return defaults;
  if (typeof value === 'boolean') return { enabled: value, withinMinutes: defaults.withinMinutes };
  if (typeof value === 'number') return { enabled: true, withinMinutes: value };
  if (isPlainObject(value)) {
    const enabled = value.enabled === undefined ? true : Boolean(value.enabled);
    let withinMinutes = Number(value.withinMinutes ?? defaults.withinMinutes);
    if (!Number.isFinite(withinMinutes) || withinMinutes <= 0) {
      warnings.push('"onlyForRecentJoiners.withinMinutes" must be a positive number — using 60.');
      withinMinutes = defaults.withinMinutes;
    }
    return { enabled, withinMinutes };
  }
  warnings.push('"onlyForRecentJoiners" has an unexpected shape — using the default (disabled).');
  return defaults;
}

function normalizeEmbed(value, warnings) {
  const embed = { ...DEFAULTS.embed };
  if (value === undefined || value === null) return embed;
  if (typeof value === 'boolean') return { ...embed, enabled: value }; // "embed": true shorthand
  if (!isPlainObject(value)) {
    warnings.push('"embed" must be an object or true/false — using defaults.');
    return embed;
  }
  for (const key of ['color', 'title', 'description', 'thumbnail', 'image', 'footer']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === 'string' || typeof value[key] === 'number') {
      embed[key] = String(value[key]);
    } else {
      warnings.push(`"embed.${key}" must be a string — ignoring it.`);
    }
  }
  if (value.enabled !== undefined) embed.enabled = Boolean(value.enabled);

  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields)) {
      warnings.push('"embed.fields" must be a list — ignoring it.');
    } else {
      embed.fields = value.fields
        .filter((field) => isPlainObject(field) && field.name !== undefined && field.value !== undefined)
        .map((field) => ({
          name: String(field.name),
          value: String(field.value),
          inline: Boolean(field.inline),
        }));
      if (embed.fields.length !== value.fields.length) {
        warnings.push('Some "embed.fields" entries were skipped — each needs both "name" and "value".');
      }
    }
  }
  return embed;
}

function normalizeCache(value, warnings) {
  const cache = { ...DEFAULTS.cache };
  if (value === undefined || value === null) return cache;
  if (!isPlainObject(value)) {
    warnings.push('"cache" must be an object — using defaults.');
    return cache;
  }
  for (const key of Object.keys(DEFAULTS.cache)) {
    if (value[key] === undefined) continue;
    const num = Number(value[key]);
    if (!Number.isFinite(num) || num < 0) {
      warnings.push(`"cache.${key}" must be a number >= 0 — using ${cache[key]}.`);
      continue;
    }
    cache[key] = Math.floor(num);
  }
  return cache;
}

function normalizeResetCommand(value, warnings) {
  const cmd = { ...DEFAULTS.resetCommand };
  if (value === undefined || value === null) return cmd;
  if (typeof value === 'boolean') return { enabled: value, trigger: cmd.trigger };
  if (typeof value === 'string') return { enabled: true, trigger: value };
  if (isPlainObject(value)) {
    if (value.enabled !== undefined) cmd.enabled = Boolean(value.enabled);
    if (value.trigger !== undefined) {
      if (typeof value.trigger === 'string' && value.trigger.trim()) cmd.trigger = value.trigger.trim();
      else warnings.push('"resetCommand.trigger" must be a non-empty string — using the default.');
    }
    return cmd;
  }
  warnings.push('"resetCommand" has an unexpected shape — using the default.');
  return cmd;
}

function normalizePositiveInt(value, fallback, key, warnings) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    warnings.push(`"${key}" must be a number >= 0 — using ${fallback}.`);
    return fallback;
  }
  return Math.floor(num);
}

function looksLikeToken(token) {
  return /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(token);
}

/**
 * @param {string} configPath absolute path to the config file
 * @returns {{ config: object, warnings: string[], token: string, path: string, dotenvPath: string|null }}
 */
function loadConfig(configPath) {
  const warnings = [];
  let raw = {};

  if (!fs.existsSync(configPath)) {
    warnings.push(
      `Config file not found at ${configPath} — falling back to built-in defaults. ` +
        'Copy config.example.json to config.json to customise the bot.',
    );
  } else {
    const text = fs.readFileSync(configPath, 'utf8');
    let parsed;
    try {
      parsed = parseJsonc(text, path.basename(configPath));
    } catch (err) {
      throw err;
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`${path.basename(configPath)} must contain a JSON object at the top level.`);
    }
    raw = parsed;
  }

  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) warnings.push(`Unknown config key "${key}" — check for a typo.`);
  }

  const config = { ...DEFAULTS, ...raw };

  for (const key of ['guilds', 'channels', 'ignoreChannels', 'ignoreUsers', 'ignoreRoles']) {
    config[key] = normalizeList(raw[key], key, warnings);
  }
  config.onlyForRecentJoiners = normalizeRecentJoiners(raw.onlyForRecentJoiners, warnings);
  config.embed = normalizeEmbed(raw.embed, warnings);
  config.cache = normalizeCache(raw.cache, warnings);
  config.resetCommand = normalizeResetCommand(raw.resetCommand, warnings);
  config.deleteAfterSeconds = normalizePositiveInt(
    raw.deleteAfterSeconds,
    DEFAULTS.deleteAfterSeconds,
    'deleteAfterSeconds',
    warnings,
  );
  config.ignoreBots = raw.ignoreBots === undefined ? DEFAULTS.ignoreBots : Boolean(raw.ignoreBots);
  config.mentionUser = raw.mentionUser === undefined ? DEFAULTS.mentionUser : Boolean(raw.mentionUser);
  config.allowEveryoneMention =
    raw.allowEveryoneMention === undefined ? DEFAULTS.allowEveryoneMention : Boolean(raw.allowEveryoneMention);
  config.replyToMessage = raw.replyToMessage === undefined ? DEFAULTS.replyToMessage : Boolean(raw.replyToMessage);
  config.deleteTriggerMessage =
    raw.deleteTriggerMessage === undefined ? DEFAULTS.deleteTriggerMessage : Boolean(raw.deleteTriggerMessage);
  config.seedExistingMembersOnFirstRun =
    raw.seedExistingMembersOnFirstRun === undefined
      ? DEFAULTS.seedExistingMembersOnFirstRun
      : Boolean(raw.seedExistingMembersOnFirstRun);
  config.dryRun = raw.dryRun === undefined ? DEFAULTS.dryRun : Boolean(raw.dryRun);

  if (typeof config.message !== 'string') {
    warnings.push('"message" must be a string — using the default message.');
    config.message = DEFAULTS.message;
  }
  if (typeof config.dataFile !== 'string' || !config.dataFile.trim()) {
    warnings.push('"dataFile" must be a non-empty string — using the default.');
    config.dataFile = DEFAULTS.dataFile;
  }
  config.logLevel = ['error', 'warn', 'info', 'debug'].includes(String(config.logLevel).toLowerCase())
    ? String(config.logLevel).toLowerCase()
    : (warnings.push('"logLevel" must be one of error, warn, info, debug — using "info".'), 'info');
  if (typeof config.tokenEnvVar !== 'string' || !config.tokenEnvVar.trim()) {
    config.tokenEnvVar = DEFAULTS.tokenEnvVar;
  }

  // --- token resolution: config.json -> process env -> .env file -----------
  const envVarName = config.tokenEnvVar.trim();
  let token = typeof config.token === 'string' ? config.token.trim() : '';
  let dotenvPath = null;
  if (!token) {
    token = (process.env[envVarName] || '').trim();
  }
  if (!token) {
    dotenvPath = path.join(path.dirname(configPath), '.env');
    const fromFile = readDotEnv(dotenvPath)[envVarName];
    if (fromFile) token = fromFile.trim();
    else dotenvPath = null;
  }
  if (token && !looksLikeToken(token)) {
    warnings.push('The bot token does not look like a Discord token (expected something like "MTIz...abc.def...").');
  }

  if (!config.guilds.length) config.guilds = [];

  return { config, warnings, token, path: configPath, dotenvPath };
}

/** Human-readable summary used by `npm run check`. */
function describeConfig(config, token, configPath) {
  const lines = [];
  const on = (v) => (v ? 'yes' : 'no');
  lines.push(`config file ....... ${configPath}`);
  lines.push(`token ............. ${token ? `set (${token.slice(0, 6)}…, ${token.length} chars)` : 'MISSING'}`);
  lines.push(`servers (guilds) .. ${config.guilds.length ? config.guilds.join(', ') : 'all servers'}`);
  lines.push(
    `active channels ... ${config.channels.length ? config.channels.join(', ') : 'ALL channels (list is empty)'}`,
  );
  lines.push(`ignored channels .. ${config.ignoreChannels.length ? config.ignoreChannels.join(', ') : 'none'}`);
  lines.push(`ignored users ..... ${config.ignoreUsers.length ? config.ignoreUsers.join(', ') : 'none'}`);
  lines.push(`ignored roles ..... ${config.ignoreRoles.length ? config.ignoreRoles.join(', ') : 'none'}`);
  lines.push(`ignore bots ....... ${on(config.ignoreBots)}`);
  lines.push(
    `recent joiners .... ${
      config.onlyForRecentJoiners.enabled
        ? `yes — greeted only if they joined less than ${config.onlyForRecentJoiners.withinMinutes} min ago`
        : 'no — anyone whose first message the bot has not seen yet'
    }`,
  );
  lines.push(`seed existing ..... ${on(config.seedExistingMembersOnFirstRun)}`);
  lines.push(`greeting mode ..... ${config.embed.enabled ? 'embed' : 'plain text'}`);
  lines.push(
    `message ........... ${
      config.embed.enabled
        ? JSON.stringify(config.embed.title || config.embed.description || '(empty embed)')
        : JSON.stringify(config.message)
    }`,
  );
  lines.push(`ping the member ... ${on(config.mentionUser)}`);
  lines.push(`reply to message .. ${on(config.replyToMessage)}`);
  lines.push(
    `auto-delete ....... ${
      config.deleteAfterSeconds ? `greeting after ${config.deleteAfterSeconds}s` : 'no'
    }${config.deleteTriggerMessage ? ', plus the triggering message' : ''}`,
  );
  lines.push(`cache ............. ${config.cache.messagesPerChannel} message(s) per channel, ${config.cache.members ? `${config.cache.members} member(s)` : 'all members'}`);
  lines.push(`dry run ........... ${on(config.dryRun)}`);
  lines.push(`state file ........ ${config.dataFile}`);
  lines.push(
    `reset command ..... ${
      config.resetCommand.enabled ? `enabled: "${config.resetCommand.trigger} @user"` : 'disabled'
    }`,
  );
  lines.push(`log level ......... ${config.logLevel}`);
  return lines.join('\n');
}

module.exports = { DEFAULTS, ID_LIKE, loadConfig, describeConfig, readDotEnv };
