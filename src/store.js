'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const logger = require('./logger');

/**
 * Remembers which members have already had their "first message" so the bot
 * greets each person at most once, even across restarts.
 *
 * File layout:
 * {
 *   "version": 1,
 *   "guilds": {
 *     "123456789012345678": {
 *       "seededAt": "2026-10-07T10:00:00.000Z" | null,
 *       "users": { "987654321098765432": 1762500000000 }
 *     }
 *   }
 * }
 *
 * Writes are debounced and atomic (temp file + rename), so a crash mid-save
 * cannot leave a half-written state file behind.
 */

const VERSION = 1;

class SeenStore {
  /**
   * @param {object} options
   * @param {string} options.file absolute path of the state file
   * @param {number} [options.saveDelayMs] debounce window for disk writes
   */
  constructor({ file, saveDelayMs = 2000 }) {
    this.file = file;
    this.saveDelayMs = saveDelayMs;
    this.data = { version: VERSION, guilds: {} };
    this.existedOnDisk = false;
    this._timer = null;
    this._dirty = false;
    this._pending = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.guilds && typeof parsed.guilds === 'object') {
        this.data = { version: VERSION, guilds: parsed.guilds };
        this.existedOnDisk = true;
      } else {
        logger.warn(`${this.file} has an unexpected shape — starting with an empty list.`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Could not read ${this.file} (${err.message}) — starting with an empty list.`);
      }
    }
    return this;
  }

  _guild(guildId, create = false) {
    const id = String(guildId);
    let guild = this.data.guilds[id];
    if (!guild) {
      if (!create) return null;
      guild = { seededAt: null, users: {} };
      this.data.guilds[id] = guild;
    }
    if (!guild.users || typeof guild.users !== 'object') guild.users = {};
    return guild;
  }

  /** Has this member already been seen/greeted in this server? */
  has(guildId, userId) {
    const guild = this._guild(guildId);
    return Boolean(guild && Object.prototype.hasOwnProperty.call(guild.users, String(userId)));
  }

  /** @returns {boolean} true when something actually changed */
  mark(guildId, userId, timestamp = Date.now()) {
    if (!guildId || !userId) return false;
    const guild = this._guild(guildId, true);
    const key = String(userId);
    if (Object.prototype.hasOwnProperty.call(guild.users, key)) return false;
    guild.users[key] = timestamp;
    this._scheduleSave();
    return true;
  }

  /** Bulk version used when seeding existing members. @returns {number} how many were added */
  markMany(guildId, userIds, timestamp = Date.now()) {
    const guild = this._guild(guildId, true);
    let added = 0;
    for (const userId of userIds) {
      const key = String(userId);
      if (Object.prototype.hasOwnProperty.call(guild.users, key)) continue;
      guild.users[key] = timestamp;
      added += 1;
    }
    if (added) this._scheduleSave();
    return added;
  }

  /** Forget a member so they can be greeted again (used by the reset command). */
  unmark(guildId, userId) {
    const guild = this._guild(guildId);
    const key = String(userId);
    if (!guild || !Object.prototype.hasOwnProperty.call(guild.users, key)) return false;
    delete guild.users[key];
    this._scheduleSave();
    return true;
  }

  /**
   * Forget everyone in a server. The "seeded" flag is kept on purpose:
   * otherwise the next restart would seed the server again (and silently
   * greet nobody), which is confusing right after a manual reset.
   */
  clearGuild(guildId) {
    const id = String(guildId);
    const existing = this.data.guilds[id];
    if (!existing) return 0;
    const removed = Object.keys(existing.users || {}).length;
    this.data.guilds[id] = { seededAt: existing.seededAt ?? null, users: {} };
    this._scheduleSave();
    return removed;
  }

  isSeeded(guildId) {
    const guild = this._guild(guildId);
    return Boolean(guild && guild.seededAt);
  }

  markSeeded(guildId) {
    const guild = this._guild(guildId, true);
    guild.seededAt = new Date().toISOString();
    this._scheduleSave();
  }

  count(guildId) {
    const guild = this._guild(guildId);
    return guild ? Object.keys(guild.users).length : 0;
  }

  stats() {
    const guilds = Object.keys(this.data.guilds).length;
    const users = Object.values(this.data.guilds).reduce(
      (total, guild) => total + Object.keys(guild.users || {}).length,
      0,
    );
    return { guilds, users, file: this.file };
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, this.saveDelayMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** Writes to disk immediately (call on shutdown / after seeding). */
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return this._pending;
    this._dirty = false;
    this._pending = this._pending.then(async () => {
      const dir = path.dirname(this.file);
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(this.data, null, 1)}\n`, 'utf8');
      await fsp.rename(tmp, this.file);
      logger.debug(`Saved state to ${this.file} (${this.stats().users} members tracked).`);
    });
    return this._pending;
  }
}

module.exports = { SeenStore, VERSION };
