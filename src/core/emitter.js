'use strict';
/** Minimal event emitter (works in Node and browsers). */
class Emitter {
  constructor() { this._l = new Map(); }
  on(evt, fn) {
    if (!this._l.has(evt)) this._l.set(evt, new Set());
    this._l.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { const s = this._l.get(evt); if (s) s.delete(fn); }
  emit(evt, payload) {
    const s = this._l.get(evt);
    if (s) for (const fn of [...s]) fn(payload);
  }
}
module.exports = { Emitter };
