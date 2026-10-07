'use strict';

const { matchesAnyReference } = require('./match');

/**
 * The whole "should this message trigger a greeting?" decision, as a pure
 * function — easy to unit test, no Discord objects required.
 *
 * @typedef {object} EligibilityContext
 * @property {object}   config          resolved config
 * @property {string}   [guildId]
 * @property {string}   [guildName]
 * @property {boolean}  isDM
 * @property {boolean}  isSystem        join/boost system messages
 * @property {boolean}  isSelf          authored by the bot itself
 * @property {string}   [authorId]
 * @property {boolean}  authorIsBot
 * @property {Array<{id?:string,name?:string}>} channelRefs  channel, its parent (threads), its category
 * @property {Array<{id?:string,name?:string}>} memberRoles
 * @property {number|null} memberJoinedAt  ms since epoch, or null when unknown
 * @property {number}   [now]
 *
 * @param {EligibilityContext} ctx
 * @param {{ has: (guildId: string, userId: string) => boolean }} store
 * @returns {{ greet: boolean, markSeen: boolean, reason: string }}
 */
function evaluate(ctx, store) {
  const { config } = ctx;
  const now = ctx.now ?? Date.now();

  const skip = (reason) => ({ greet: false, markSeen: false, reason }); // eligible later, don't remember anything
  const done = (reason) => ({ greet: false, markSeen: true, reason }); // never greet this member
  const greet = (reason) => ({ greet: true, markSeen: true, reason });

  if (ctx.isDM) return skip('direct-message');
  if (!ctx.guildId) return skip('no-guild');
  if (ctx.isSystem) return skip('system-message');
  if (ctx.isSelf) return skip('own-message');
  if (!ctx.authorId) return skip('missing-author');
  if (config.ignoreBots && ctx.authorIsBot) return skip('bot-author');

  if (config.guilds.length && !matchesAnyReference(config.guilds, { id: ctx.guildId, name: ctx.guildName })) {
    return skip('server-not-selected');
  }

  if (store.has(ctx.guildId, ctx.authorId)) return skip('already-greeted-this-member');

  if (matchesAnyReference(config.ignoreUsers, { id: ctx.authorId })) return done('author-ignored');
  if (matchesAnyReference(config.ignoreRoles, ctx.memberRoles || [])) return done('role-ignored');

  const refs = ctx.channelRefs || [];

  // An empty `channels` list means "every channel".
  if (config.channels.length && !matchesAnyReference(config.channels, refs)) {
    return skip('channel-not-active');
  }
  if (matchesAnyReference(config.ignoreChannels, refs)) return skip('channel-ignored');

  const recent = config.onlyForRecentJoiners;
  if (recent.enabled && ctx.memberJoinedAt) {
    const ageMinutes = (now - ctx.memberJoinedAt) / 60000;
    if (ageMinutes > recent.withinMinutes) return done('joined-too-long-ago');
  }

  return greet('first-message');
}

const EXPLANATIONS = {
  'first-message': 'first message seen from this member — greeting them',
  'direct-message': 'direct messages are ignored',
  'no-guild': 'message is not in a server',
  'system-message': 'system message',
  'own-message': 'message written by the bot itself',
  'missing-author': 'message has no author id',
  'bot-author': 'author is a bot (ignoreBots is on)',
  'server-not-selected': 'server is not in the "guilds" list',
  'already-greeted-this-member': 'this member was already greeted/seeded',
  'author-ignored': 'author is in ignoreUsers',
  'role-ignored': 'author has an ignored role',
  'channel-not-active': 'channel is not in the "channels" list',
  'channel-ignored': 'channel (or its category) is in ignoreChannels',
  'joined-too-long-ago': 'joined longer ago than onlyForRecentJoiners.withinMinutes',
};

module.exports = { evaluate, EXPLANATIONS };
