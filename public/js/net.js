/**
 * net.js — the only file that talks to the server.
 *
 * Contract:
 *   in   state:full / gift / fish:remove / game:reset / tiktok:status
 *   out  fish:sync (batched combat results), fish:dead
 *
 * The socket handles live events; the REST call handles cold start. Both exist
 * on purpose: if the socket is slow to connect after a refresh, the arena is
 * already repopulated from /api/state and the stream never shows an empty tank.
 */

const SYNC_INTERVAL_MS = 1200;

export class Net {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.socket = null;
    this.syncTimer = null;
    this.pendingSync = new Map();
  }

  /** Cold start: pull the persisted arena straight from MongoDB. */
  async fetchState() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn('[net] state restore failed:', err.message);
      return { ok: false, fish: [], maxActive: 40, restoredFromDb: false };
    }
  }

  connect() {
    // socket.io client is served by our own Node process at /socket.io/socket.io.js
    // so this works with no internet connection.
    this.socket = io({ transports: ['websocket', 'polling'] });

    this.socket.on('connect', () => this.handlers.onConnect?.());
    this.socket.on('disconnect', () => this.handlers.onDisconnect?.());
    this.socket.on('state:full', (payload) => this.handlers.onFullState?.(payload));
    this.socket.on('gift', (payload) => this.handlers.onGift?.(payload));
    this.socket.on('fish:remove', (payload) => this.handlers.onRemove?.(payload));
    this.socket.on('game:reset', (payload) => this.handlers.onReset?.(payload));
    this.socket.on('tiktok:status', (payload) => this.handlers.onTikTokStatus?.(payload));

    this.syncTimer = setInterval(() => this._flushSync(), SYNC_INTERVAL_MS);
  }

  /**
   * Queue a combat HP change for persistence. Coalesced by username so a fish
   * taking 40 bites in a second still costs exactly one entry.
   */
  queueSync(username, hp) {
    this.pendingSync.set(username, hp);
  }

  _flushSync() {
    if (!this.socket?.connected || this.pendingSync.size === 0) return;
    const batch = [...this.pendingSync].map(([username, hp]) => ({ username, hp }));
    this.pendingSync.clear();
    this.socket.emit('fish:sync', batch);
  }

  reportDeath(username) {
    this.pendingSync.delete(username);
    this.socket?.emit('fish:dead', { username });
  }

  /** Admin reset. The key never touches a URL or query string. */
  async requestReset(key, confirm) {
    const res = await fetch('/api/admin/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ confirm })
    });
    return res.json();
  }
}
