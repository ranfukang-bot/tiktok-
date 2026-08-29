import { EventEmitter } from 'node:events';

const MAX_LINES = 500;
const bus = new EventEmitter();
bus.setMaxListeners(50);
const ring = [];

export function publish(accountName, level, message) {
  const entry = { time: Date.now(), account: accountName, level, message };
  ring.push(entry);
  if (ring.length > MAX_LINES) ring.shift();
  bus.emit('log', entry);
  return entry;
}

export function recentLogs() {
  return ring.slice();
}

export function subscribe(handler) {
  bus.on('log', handler);
  return () => bus.off('log', handler);
}
