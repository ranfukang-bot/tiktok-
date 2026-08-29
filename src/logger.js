export function createLogger(accountName) {
  const prefix = `[${accountName}]`;
  return {
    info(msg) {
      console.log(`${new Date().toISOString()} ${prefix} ${msg}`);
    },
    warn(msg) {
      console.warn(`${new Date().toISOString()} ${prefix} ⚠️ ${msg}`);
    },
    error(msg) {
      console.error(`${new Date().toISOString()} ${prefix} ❌ ${msg}`);
    },
  };
}
