#!/usr/bin/env node
'use strict';

const path = require('path');
const { Client, GatewayIntentBits, Partials, Events, Options } = require('discord.js');
const logger = require('./logger');
const { loadConfig, describeConfig } = require('./config');
const { SeenStore } = require('./store');
const { handleMessage } = require('./greeter');
const { matchesAnyReference } = require('./match');

const HELP = `
first-message-bot — greets members the first time they speak in your server.

Usage:
  node src/index.js [options]

Options:
  --config <file>       Path to the config file (default: ./config.json)
  --dry-run             Log what would be sent instead of sending anything
  --log-level <level>   error | warn | info | debug  (overrides the config file)
  --check               Validate the config, print a summary and exit
  --help                Show this help
  --version             Show the version

The bot token is read from config.json ("token"), then from the environment
variable named by "tokenEnvVar" (default DISCORD_TOKEN), then from a .env file
next to the config file.
`;

function parseArgs(argv) {
  // Default to the config.json that sits next to package.json, so the bot can
  // be started from any working directory.
  const args = {
    config: path.join(__dirname, '..', 'config.json'),
    dryRun: false,
    logLevel: null,
    check: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Option ${arg} needs a value.`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--config':
      case '-c':
        args.config = next();
        break;
      case '--log-level':
        args.logLevel = next();
        break;
      case '--dry-run':
      case '-n':
        args.dryRun = true;
        break;
      case '--check':
        args.check = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      default:
        if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length);
        else if (arg.startsWith('--log-level=')) args.logLevel = arg.slice('--log-level='.length);
        else throw new Error(`Unknown option "${arg}". Try --help.`);
    }
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  if (args.help) return void console.log(HELP.trim());
  if (args.version) return void console.log(require('../package.json').version);

  const configPath = path.resolve(args.config);
  const { config, warnings, token } = loadConfig(configPath);
  if (args.dryRun) config.dryRun = true;

  // The command line wins over the config file, but only when it makes sense.
  const level = String(args.logLevel ?? config.logLevel).toLowerCase();
  config.logLevel = ['error', 'warn', 'info', 'debug'].includes(level) ? level : 'info';
  logger.setLevel(config.logLevel);
  if (config.logLevel !== level) logger.warn(`Unknown log level "${args.logLevel}" — using "info".`);

  console.log(`\n${describeConfig(config, token, configPath)}\n`);
  for (const warning of warnings) logger.warn(warning);

  if (args.check) {
    logger.info('Config looks fine — nothing was started (--check).');
    return;
  }

  if (!token) {
    logger.error(
      'No bot token found. Put it in config.json ("token"), or export it as an environment variable,\n' +
        '            or create a .env file next to the config with:  DISCORD_TOKEN=your-token-here\n' +
        '            Never commit the token to git.',
    );
    process.exitCode = 1;
    return;
  }

  const dataFile = path.isAbsolute(config.dataFile)
    ? config.dataFile
    : path.resolve(path.dirname(configPath), config.dataFile);
  const store = new SeenStore({ file: dataFile });
  await store.load();
  const stats = store.stats();
  logger.info(`State file loaded — ${stats.users} member(s) already greeted across ${stats.guilds} server(s).`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // required to read message text / trigger the reset command
      GatewayIntentBits.GuildMembers, // required for "onlyForRecentJoiners" and the seeding option
    ],
    partials: [Partials.Channel], // lets the bot see DMs it should ignore instead of crashing on them

    // This bot only ever looks at the message it just received, so most caches
    // are dead weight. Keeping them tiny is what keeps a large server cheap:
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings, // leave discord.js defaults for everything else
      MessageManager: config.cache.messagesPerChannel,
      PresenceManager: 0,
      ReactionManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
      StageInstanceManager: 0,
      VoiceStateManager: 0,
      InviteManager: 0,
      ...(config.cache.members > 0
        ? { GuildMemberManager: { maxSize: config.cache.members, keepOverLimit: (member) => member.id === member.client.user?.id } }
        : {}),
    }),
  });

  if (config.cache.members > 0) {
    logger.info(
      `Member cache limited to ${config.cache.members} entries — members outside it are fetched on demand ` +
        'when they speak for the first time.',
    );
  }

  client.on(Events.Error, (err) => logger.error(`Gateway error: ${err.message}`));
  client.on(Events.Warn, (msg) => logger.debug(`Gateway warning: ${msg}`));

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag} (${readyClient.user.id})`);
    logger.info(
      `Active in: ${config.guilds.length ? config.guilds.join(', ') : 'every server it is a member of'}; ` +
        `channels: ${config.channels.length ? config.channels.join(', ') : 'ALL channels'}` +
        `${config.ignoreChannels.length ? ` (ignoring ${config.ignoreChannels.join(', ')})` : ''}.`,
    );
    if (config.dryRun) logger.warn('Dry run is ENABLED — no message will actually be sent.');

    for (const guild of readyClient.guilds.cache.values()) {
      const selected = matchesAnyReference(config.guilds, { id: guild.id, name: guild.name }) || !config.guilds.length;
      if (!selected) {
        logger.debug(`Skipping "${guild.name}" (not in the "guilds" list).`);
        continue;
      }
      if (config.seedExistingMembersOnFirstRun) await seedExistingMembers(guild, store);
      logger.info(`  • ${guild.name} — ${store.count(guild.id)} member(s) marked as already greeted.`);
    }

    logger.info('Ready. Waiting for first messages…');
  });

  // Invited to a new server while running: honour the seeding option there too.
  client.on(Events.GuildCreate, async (guild) => {
    logger.info(`Joined server "${guild.name}".`);
    if (config.seedExistingMembersOnFirstRun) await seedExistingMembers(guild, store);
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage({ config, store }, message).catch((err) =>
      logger.error(`Unexpected error while handling a message: ${err.stack || err.message || err}`),
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — saving state and shutting down.`);
    try {
      await store.flush();
    } catch (err) {
      logger.error(`Could not save the state file: ${err.message}`);
    }
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error(`Unhandled rejection: ${err?.stack || err}`));
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err?.stack || err}`);
    shutdown('uncaughtException');
  });

  try {
    await client.login(token);
  } catch (err) {
    logger.error(`Login failed: ${err.message}`);
    logger.error('Check that the token is correct and that both privileged intents are enabled in the');
    logger.error('Discord Developer Portal: Bot → Privileged Gateway Intents → SERVER MEMBERS + MESSAGE CONTENT.');
    process.exitCode = 1;
  }
}

/**
 * Marks every current member as "already greeted" so only people who arrive
 * *after* this point get the message. Runs once per server unless the state
 * file is deleted (or the reset command cleared the flag).
 */
async function seedExistingMembers(guild, store) {
  if (store.isSeeded(guild.id)) {
    logger.debug(`"${guild.name}" was seeded before — not seeding again.`);
    return;
  }
  try {
    const members = await guild.members.fetch();
    const added = store.markMany(guild.id, members.map((member) => member.id));
    store.markSeeded(guild.id);
    await store.flush();
    logger.info(`Seeded "${guild.name}": ${added} existing member(s) will not be greeted.`);
  } catch (err) {
    logger.warn(
      `Could not seed "${guild.name}" (${err.message}). The SERVER MEMBERS intent must be enabled for this.`,
    );
  }
}

main().catch((err) => {
  logger.error(`Fatal: ${err.stack || err.message || err}`);
  process.exitCode = 1;
});
