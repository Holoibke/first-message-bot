'use strict';

const { PermissionFlagsBits } = require('discord.js');
const logger = require('./logger');
const { evaluate, EXPLANATIONS } = require('./eligibility');
const { buildVars, buildPayload, previewPayload } = require('./template');

const MAX_DELETE_SECONDS = 604800; // Discord refuses anything above 7 days
const TRIGGER_DELETE_SECONDS = 5; // how long the member's first message stays before it is cleaned up

/**
 * Collects the names/IDs a channel can be referred to by in the config:
 * its own name/ID, its parent (a thread's channel, or a channel's category)
 * and, for threads, the category above that.
 */
function channelRefsOf(message) {
  const refs = [];
  const channel = message.channel;
  if (!channel) return refs;
  refs.push({ id: channel.id, name: channel.name });
  const parent = channel.parent;
  if (parent) {
    refs.push({ id: parent.id, name: parent.name });
    if (parent.parent) refs.push({ id: parent.parent.id, name: parent.parent.name });
  }
  return refs;
}

function rolesOf(member) {
  const roles = member?.roles?.cache;
  if (!roles) return [];
  return roles.map((role) => ({ id: role.id, name: role.name }));
}

function joinedAtOf(member) {
  return member?.joinedAt ? new Date(member.joinedAt).getTime() : null;
}

/**
 * The member object behind a message, fetching it if it is not in the cache.
 *
 * Why: `message.member` is read from the cache, and the cache can be capped
 * with `cache.members` in the config (or evicted), so it may be null even in
 * a normal server. Role and join-date checks need the real member, so we ask
 * the API — but only for members we have not greeted yet, which happens at
 * most once per member. If the fetch fails (no "Server Members" intent, no
 * permission, member left) the greeting still works, minus role/join checks.
 */
async function resolveMember(message, store) {
  if (message.member) return message.member;
  if (!message.guild?.members?.fetch || !message.author?.id) return null;
  if (store.has(message.guildId, message.author.id)) return null; // nothing left to check

  try {
    return (await message.guild.members.fetch(message.author.id)) ?? null;
  } catch (err) {
    logger.debug(
      `Could not fetch member ${message.author.id} (${err.message}) — continuing without role/join data.`,
    );
    return null;
  }
}

/** Runs the decision, updates the "seen" list and sends the greeting if needed. */
async function handleMessage({ config, store }, message) {
  try {
    if (config.resetCommand.enabled && (await maybeHandleResetCommand({ config, store }, message))) {
      return;
    }

    // Webhook messages are treated as normal messages (often used by bridges),
    // but bot accounts are not remembered at all when ignoreBots is on.
    const isWebhook = Boolean(message.webhookId);
    if (config.ignoreBots && message.author?.bot && !isWebhook) {
      logger.debug(`Ignoring message from bot ${message.author.tag} (ignoreBots is on).`);
      return;
    }

    const member = await resolveMember(message, store);

    const decision = evaluate(
      {
        config,
        guildId: message.guildId,
        guildName: message.guild?.name,
        isDM: !message.guild,
        isSystem: message.system,
        isSelf: message.author?.id === message.client?.user?.id,
        authorId: message.author?.id,
        authorIsBot: Boolean(message.author?.bot) && !isWebhook,
        channelRefs: channelRefsOf(message),
        memberRoles: rolesOf(member),
        memberJoinedAt: joinedAtOf(member),
      },
      store,
    );

    const who = message.author?.tag ?? message.author?.id ?? 'unknown';
    const where = message.guild ? `${message.guild.name} #${message.channel?.name ?? '?'}` : 'a DM';

    if (!decision.greet) {
      if (decision.markSeen) store.mark(message.guildId, message.author.id);
      logger.debug(`Not greeting ${who} in ${where}: ${EXPLANATIONS[decision.reason] ?? decision.reason}.`);
      return;
    }

    // Mark before sending: if Discord rejects the message we still do not want
    // to greet this member on every subsequent message.
    store.mark(message.guildId, message.author.id);
    logger.info(`Greeting ${who} in ${where}: ${EXPLANATIONS[decision.reason] ?? decision.reason}.`);

    const delivered = await sendGreeting({ config }, message, member);
    if (!delivered) {
      // Nothing was posted: forget the member again so the next message retries.
      store.unmark(message.guildId, message.author.id);
      logger.warn(`The greeting for ${who} was not delivered — they will be greeted again on their next message.`);
    }
  } catch (err) {
    logger.error(`Failed to handle a message: ${err.stack || err.message || err}`);
  }
}

/**
 * Sends the greeting.
 * @returns {Promise<boolean>} false when nothing was posted, so the caller can
 *   undo the "seen" mark and retry on the member's next message.
 */
async function sendGreeting({ config }, message, member = message.member) {
  const vars = buildVars({
    user: message.author,
    member,
    guild: message.guild,
    channel: message.channel,
  });
  if (!config.mentionUser) {
    // Leave a readable name behind instead of a dead <@id> mention.
    vars.mention = member?.displayName ?? message.author.username ?? '';
  }

  const payload = buildPayload(config, vars, message.author.id);

  if (config.dryRun) {
    logger.info(`[dry run] Would send in #${message.channel?.name ?? '?'}: ${previewPayload(payload)}`);
    return true;
  }

  const sendOptions = { ...payload };
  if (config.replyToMessage) {
    sendOptions.reply = { messageReference: message, failIfNotExists: false };
  }

  let sent;
  try {
    sent = await message.channel.send(sendOptions);
  } catch (err) {
    logger.error(
      `Could not send the greeting in #${message.channel?.name ?? '?'} (${err.message}). ` +
        'Check that the bot has "Send Messages" and "Embed Links" permission in that channel.',
    );
    return false;
  }

  if (config.deleteAfterSeconds > 0) {
    scheduleDelete(sent, Math.min(config.deleteAfterSeconds, MAX_DELETE_SECONDS), 'greeting');
  }
  if (config.deleteTriggerMessage && message.deletable) {
    scheduleDelete(message, TRIGGER_DELETE_SECONDS, 'triggering message');
  }
  return true;
}

/** Deletes something later without keeping the process alive on shutdown. */
function scheduleDelete(target, seconds, label) {
  const timer = setTimeout(() => {
    target.delete().catch((err) => logger.debug(`Could not delete the ${label}: ${err.message}`));
  }, Math.max(seconds, 1) * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  logger.debug(`Scheduled deletion of the ${label} in ${seconds}s.`);
}

// --- the small admin command ----------------------------------------------

/** `!firstmsg-reset @user | <user id> | all` — lets a member be greeted again. */
async function maybeHandleResetCommand({ config, store }, message) {
  const command = config.resetCommand;
  const content = (message.content ?? '').trim();
  if (!content.toLowerCase().startsWith(command.trigger.toLowerCase())) return false;

  const reply = async (text) => {
    try {
      await message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } });
    } catch (err) {
      logger.warn(`Could not reply to the reset command (${err.message}).`);
    }
  };

  if (!message.guild) return false;

  const canUse = message.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canUse) {
    // Silently ignore for everyone else: nice for members, quiet for logs.
    logger.debug(`Ignored "${command.trigger}" from ${message.author?.tag} (needs the "Manage Server" permission).`);
    return true;
  }

  const args = content.slice(command.trigger.length).trim().split(/\s+/).filter(Boolean);
  const usage =
    `Usage: \`${command.trigger} @member\` — forget one member\n` +
    `• \`${command.trigger} <user id>\` — same, by ID\n` +
    `• \`${command.trigger} all\` — forget every member in this server`;

  if (!args.length) {
    await reply(`Nothing to do.\n${usage}`);
    return true;
  }

  if (['all', 'everyone', '*'].includes(args[0].toLowerCase())) {
    if (config.dryRun) {
      await reply('Dry run is enabled — nothing was changed.');
      return true;
    }
    const removed = store.clearGuild(message.guild.id);
    await store.flush();
    logger.info(`${message.author.tag} cleared the seen list for "${message.guild.name}" (${removed} members).`);
    await reply(`Forgot ${removed} member(s). Everyone here can be greeted again — including yourself.`);
    return true;
  }

  const mentioned = message.mentions?.users?.first();
  const rawId = args[0].replace(/[<@!>]/g, '');
  const userId = mentioned?.id ?? (/^\d{15,25}$/.test(rawId) ? rawId : null);

  if (!userId) {
    await reply(`I could not read a member from \`${args[0]}\`.\n${usage}`);
    return true;
  }

  if (config.dryRun) {
    await reply('Dry run is enabled — nothing was changed.');
    return true;
  }

  const removed = store.unmark(message.guild.id, userId);
  await store.flush();
  logger.info(
    `${message.author.tag} reset ${removed ? '' : '(nothing to reset for) '}member ${userId} in "${message.guild.name}".`,
  );
  await reply(
    removed
      ? `<@${userId}> was forgotten — their next message will trigger the greeting again.`
      : `<@${userId}> was not in the seen list, so nothing changed.`,
  );
  return true;
}

module.exports = {
  handleMessage,
  sendGreeting,
  maybeHandleResetCommand,
  channelRefsOf,
  rolesOf,
  joinedAtOf,
  resolveMember,
  TRIGGER_DELETE_SECONDS,
};
