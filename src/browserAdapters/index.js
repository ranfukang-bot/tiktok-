import { createAdsPowerAdapter } from './adspower.js';
import { createHubstudioAdapter } from './hubstudio.js';

export function createAdapter(kind, settings) {
  if (kind === 'adspower') return createAdsPowerAdapter(settings.adspower || {});
  if (kind === 'hubstudio') return createHubstudioAdapter(settings.hubstudio || {});
  throw new Error(`未知的指纹浏览器类型: ${kind}（目前支持 adspower / hubstudio）`);
}
