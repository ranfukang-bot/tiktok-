import { publish } from './logBus.js';

export function createLogger(accountName) {
  const prefix = `[${accountName}]`;
  return {
    info(msg) {
      console.log(`${new Date().toISOString()} ${prefix} ${msg}`);
      publish(accountName, 'info', msg);
    },
    warn(msg) {
      console.warn(`${new Date().toISOString()} ${prefix} ⚠️ ${msg}`);
      publish(accountName, 'warn', msg);
    },
    error(msg) {
      console.error(`${new Date().toISOString()} ${prefix} ❌ ${msg}`);
      publish(accountName, 'error', msg);
    },
  };
}
