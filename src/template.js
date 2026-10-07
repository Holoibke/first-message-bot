'use strict';

const logger = require('./logger');

/**
 * Placeholder rendering + payload building for the greeting itself.
 *
 * Note: Discord display-name/role text is rendered literally — the bot never
 * interprets it as markdown, so members cannot smuggle in @everyone pings via
 * their nickname. @everyone/@here pings inside your own template are disabled
 * unless `allowEveryoneMention` is set to true.
 */

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const warnedPlaceholders = new Set();

function render(template, vars) {
  if (template === null || template === undefined) return '';
  return String(template).replace(PLACEHOLDER, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key] ?? '');
    if (!warnedPlaceholders.has(key)) {
      warnedPlaceholders.add(key);
      logger.warn(
        `Unknown placeholder {${key}} — leaving it as-is. ` +
          'See the placeholder table in README.md for the supported names.',
      );
    }
    return match;
  });
}

function discordTimestamp(ms, style = 'R') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Builds the replacement values for {placeholders}. */
function buildVars({ user, member, guild, channel, now = Date.now() }) {
  const avatar = typeof (member ?? user)?.displayAvatarURL === 'function'
    ? (member ?? user).displayAvatarURL({ size: 256 })
    : '';
  const joinedMs = member?.joinedAt ? new Date(member.joinedAt).getTime() : null;
  const createdMs = Number.isFinite(user?.createdTimestamp) ? user.createdTimestamp : null;
  const discriminator = user?.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : '';

  return {
    user: member?.displayName ?? user?.displayName ?? user?.globalName ?? user?.username ?? 'there',
    username: user?.username ?? '',
    tag: user?.username ? `${user.username}${discriminator}` : '',
    mention: user?.id ? `<@${user.id}>` : '',
    id: user?.id ?? '',
    avatar,
    server: guild?.name ?? '',
    serverIcon: typeof guild?.iconURL === 'function' ? guild.iconURL({ size: 256 }) ?? '' : '',
    memberCount: guild?.memberCount ? String(guild.memberCount) : '',
    channel: channel?.name ? `#${channel.name}` : '',
    channelMention: channel?.id ? `<#${channel.id}>` : '',
    joinedAt: joinedMs ? discordTimestamp(joinedMs, 'f') : '',
    joinedAgo: joinedMs ? discordTimestamp(joinedMs, 'R') : '',
    accountAge: createdMs ? discordTimestamp(createdMs, 'R') : '',
    time: discordTimestamp(now, 't'),
    date: discordTimestamp(now, 'D'),
  };
}

/** Accepts #rrggbb, rrggbb, 0xrrggbb or a number; falls back to blurple. */
function parseColor(value, fallback = 0x5865f2) {
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xffffff;
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '').replace(/^0x/i, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) return parseInt(hex, 16);
    if (/^\d+$/.test(hex)) return Number(hex) & 0xffffff;
  }
  logger.warn(`Could not read embed color ${JSON.stringify(value)} — using #5865F2.`);
  return fallback;
}

/**
 * Turns the config + placeholders into the exact object handed to discord.js.
 * @returns {{ content: string, embeds: object[], allowedMentions: object }}
 */
function buildPayload(config, vars, userId) {
  const mention = `<@${userId}>`;
  let content = '';
  const embeds = [];

  if (config.embed.enabled) {
    const embed = { color: parseColor(config.embed.color) };
    const title = render(config.embed.title, vars);
    if (title) embed.title = title;

    const description = render(config.embed.description || config.message, vars);
    if (description) embed.description = description;

    if (config.embed.thumbnail) embed.thumbnail = { url: render(config.embed.thumbnail, vars) };
    if (config.embed.image) embed.image = { url: render(config.embed.image, vars) };
    if (config.embed.footer) embed.footer = { text: render(config.embed.footer, vars) };

    const fields = Array.isArray(config.embed.fields) ? config.embed.fields : [];
    const rendered = fields
      .map((field) => ({
        name: render(field.name, vars).slice(0, 256),
        value: render(field.value, vars).slice(0, 1024),
        inline: Boolean(field.inline),
      }))
      .filter((field) => field.name && field.value);
    if (rendered.length) embed.fields = rendered;

    embeds.push(embed);
  } else {
    content = render(config.message, vars);
  }

  if (config.mentionUser && !content.includes(mention)) {
    content = content ? `${mention} ${content}` : mention;
  }
  if (!content && !embeds.length) {
    logger.warn('Your greeting is empty — sending a fallback. Check "message" / "embed" in the config.');
    content = config.mentionUser ? mention : '👋';
  }

  return {
    content: content || undefined,
    embeds,
    allowedMentions: {
      // Nothing is pinged implicitly: only the new member (if mentionUser is on)
      parse: config.allowEveryoneMention ? ['everyone'] : [],
      users: config.mentionUser ? [userId] : [],
      roles: [],
    },
  };
}

/** Shorthand text used in dry-run logs and tests. */
function previewPayload(payload) {
  const parts = [];
  if (payload.content) parts.push(payload.content);
  for (const embed of payload.embeds) {
    parts.push(`[embed]${embed.title ? ` ${embed.title}` : ''}${embed.description ? ` ${embed.description}` : ''}`);
  }
  return parts.join(' ');
}

module.exports = { render, buildVars, buildPayload, parseColor, previewPayload, discordTimestamp };
