/**
 * store.js — MongoDB Atlas (cloud) persistence for the arena.
 *
 * Design goals, in priority order:
 *   1. The stream never dies. If Mongo is down, the game keeps running from an
 *      in-memory map and reconnects in the background.
 *   2. Writes never block the gift pipeline. Every mutation marks a username
 *      dirty; a timer flushes dirty records with a single bulkWrite.
 *   3. A browser refresh restores everything. `loadAll()` is the source of truth
 *      at boot.
 *
 * MONGO_URL is expected to be a full Atlas connection string (mongodb+srv://
 * or the mongodb:// shard-list form Atlas also hands out) — see .env.example.
 * The fallback below is this project's own Atlas cluster so the packaged
 * .exe works out of the box with no local MongoDB; override it via .env for
 * a different cluster. DB_NAME is applied explicitly via client.db(DB_NAME)
 * regardless of any database name in the URI's own path.
 */

const { MongoClient } = require('mongodb');
const { normalize, SPAWN_HP_MIN, SPAWN_HP_MAX } = require('./rules');

const MONGO_URL = process.env.MONGO_URL
  // Least-privilege user, readWrite on tiktok_fish_battle only — rotated
  // 2026-08-17, see the matching comment in electron/firstRunConfig.js.
  || 'mongodb://fishbattle_game:Cu0Jl4m4IvcATGwt@ac-t7fhqrc-shard-00-00.z5mbjwl.mongodb.net:27017,ac-t7fhqrc-shard-00-01.z5mbjwl.mongodb.net:27017,ac-t7fhqrc-shard-00-02.z5mbjwl.mongodb.net:27017/?ssl=true&replicaSet=atlas-kp5iau-shard-0&authSource=admin&appName=Cluster0';
const DB_NAME = process.env.MONGO_DB || 'tiktok_fish_battle';
const COLLECTION = 'fish';
const FLUSH_INTERVAL_MS = 2000;
const RECONNECT_INTERVAL_MS = 10000;

class Store {
  constructor(log = console) {
    this.log = log;
    this.client = null;
    this.col = null;
    this.connected = false;

    /** @type {Map<string, object>} username -> fish document (hot cache) */
    this.cache = new Map();
    /** @type {Set<string>} usernames awaiting a database write */
    this.dirty = new Set();
    /** @type {Set<string>} usernames awaiting deletion */
    this.pendingDeletes = new Set();

    this.flushTimer = null;
    this.reconnectTimer = null;
  }

  // ---------------------------------------------------------------- lifecycle

  async connect() {
    // This project must only ever persist to MongoDB Atlas — refuse a local
    // connection string outright rather than silently connecting to it.
    // Restarting the process after fixing MONGO_URL is required to pick
    // this back up, same as any other env var, so there's no point
    // scheduling a reconnect against the same rejected URL.
    if (/localhost|127\.0\.0\.1/i.test(MONGO_URL)) {
      this.connected = false;
      this.log.error(`[store] MONGO_URL points at local MongoDB (${MONGO_URL}). This project requires MongoDB Atlas — set MONGO_URL to your Atlas connection string in .env. Running in memory until restarted with a valid MONGO_URL.`);
    } else {
      try {
        this.client = new MongoClient(MONGO_URL, {
          serverSelectionTimeoutMS: 3000,
          connectTimeoutMS: 3000
        });
        await this.client.connect();
        const db = this.client.db(DB_NAME);
        this.col = db.collection(COLLECTION);
        await this.col.createIndex({ username: 1 }, { unique: true });
        await this.col.createIndex({ hp: -1 });
        this.connected = true;
        this.log.info(`[store] connected to ${MONGO_URL}/${DB_NAME}`);

        // Warm the cache from disk so a refresh restores the arena exactly.
        const docs = await this.col.find({}).toArray();
        this.cache.clear();
        for (const doc of docs) this.cache.set(doc.username, stripId(doc));
        this.log.info(`[store] restored ${this.cache.size} fish from Atlas`);
      } catch (err) {
        this.connected = false;
        this.log.warn(`[store] MongoDB unavailable (${err.message}). Running in memory; retrying every ${RECONNECT_INTERVAL_MS / 1000}s.`);
        this.scheduleReconnect();
      }
    }

    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((e) => this.log.warn('[store] flush failed:', e.message));
      }, FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
    return this.connected;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.connected) return;
      try { await this.client?.close(); } catch { /* ignore */ }
      await this.connect();
      // Anything created while offline is still cached — push it all up.
      if (this.connected) for (const key of this.cache.keys()) this.dirty.add(key);
    }, RECONNECT_INTERVAL_MS);
    this.reconnectTimer.unref?.();
  }

  async close() {
    clearInterval(this.flushTimer);
    clearTimeout(this.reconnectTimer);
    await this.flush().catch(() => {});
    await this.client?.close().catch(() => {});
  }

  // ------------------------------------------------------------------- reads

  /** Full arena snapshot, sorted strongest-first. */
  all() {
    return [...this.cache.values()].sort((a, b) => b.hp - a.hp);
  }

  get(username) {
    return this.cache.get(username) || null;
  }

  // ------------------------------------------------------------------ writes

  /** Create the fish if this is the viewer's first appearance. */
  ensure(username, profile = {}) {
    let fish = this.cache.get(username);
    if (fish) {
      if (profile.nickname) fish.nickname = profile.nickname;
      if (profile.avatar) fish.avatar = profile.avatar;
      return fish;
    }
    fish = normalize({
      username,
      nickname: profile.nickname || username,
      avatar: profile.avatar || null,
      // Randomised inside the spawn band so arrivals aren't all identical —
      // a row of clones entering at the same size looks synthetic.
      hp: SPAWN_HP_MIN + Math.floor(Math.random() * (SPAWN_HP_MAX - SPAWN_HP_MIN + 1)),
      level: 1,
      coinsSpent: 0,
      giftsReceived: 0,
      joinedAt: new Date(),
      updatedAt: new Date()
    });
    this.cache.set(username, fish);
    this.markDirty(username);
    return fish;
  }

  /** Apply a mutation function to a fish and persist the result. */
  update(username, mutate) {
    const fish = this.cache.get(username);
    if (!fish) return null;
    mutate(fish);
    normalize(fish);
    fish.updatedAt = new Date();
    this.markDirty(username);
    return fish;
  }

  remove(username) {
    this.cache.delete(username);
    this.dirty.delete(username);
    this.pendingDeletes.add(username);
  }

  markDirty(username) {
    this.dirty.add(username);
  }

  /** Write every dirty record in one round trip. Safe to call when idle. */
  async flush(force = false) {
    if (!this.connected || !this.col) return false;
    if (!force && this.dirty.size === 0 && this.pendingDeletes.size === 0) return true;

    const ops = [];
    for (const username of this.dirty) {
      const fish = this.cache.get(username);
      if (!fish) continue;
      ops.push({
        replaceOne: { filter: { username }, replacement: fish, upsert: true }
      });
    }
    for (const username of this.pendingDeletes) {
      ops.push({ deleteOne: { filter: { username } } });
    }
    if (!ops.length) return true;

    this.dirty.clear();
    this.pendingDeletes.clear();

    try {
      await this.col.bulkWrite(ops, { ordered: false });
      return true;
    } catch (err) {
      // Connection dropped mid-write: fall back to memory and retry the batch.
      this.connected = false;
      for (const op of ops) {
        const name = op.replaceOne?.filter?.username;
        if (name) this.dirty.add(name);
      }
      this.log.warn(`[store] write failed (${err.message}); queued for retry`);
      this.scheduleReconnect();
      return false;
    }
  }

  /** Admin reset: wipe the collection and the hot cache. */
  async wipe() {
    this.cache.clear();
    this.dirty.clear();
    this.pendingDeletes.clear();
    if (this.connected && this.col) {
      await this.col.deleteMany({});
    }
    return true;
  }
}

function stripId(doc) {
  const { _id, ...rest } = doc;
  return rest;
}

module.exports = { Store, MONGO_URL, DB_NAME, COLLECTION };
