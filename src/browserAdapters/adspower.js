// AdsPower 本地API (v1)：https://localapi-doc-en.adspower.com/
// 默认地址 http://local.adspower.net:50325 ，团队版才能用，需要在客户端里打开"启用API"。
export function createAdsPowerAdapter(settings) {
  const baseUrl = (settings.baseUrl || 'http://local.adspower.net:50325').replace(/\/$/, '');

  async function call(pathname, params = {}) {
    const url = new URL(baseUrl + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (settings.apiKey) url.searchParams.set('api_key', settings.apiKey);
    let json;
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`AdsPower接口 ${pathname} HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      throw new Error(`连不上 AdsPower 指纹浏览器客户端或响应异常（最多等待120秒），请检查客户端和本地API：${err.message}`, { cause: err });
    }
    if (json.code !== 0) {
      throw new Error(`AdsPower接口 ${pathname} 返回错误: ${json.msg || JSON.stringify(json)}`);
    }
    return json.data;
  }

  return {
    name: 'adspower',

    // 返回可供 Playwright chromium.connectOverCDP() 使用的 ws 端点
    async startProfile(account) {
      const profileId = account.profileId;
      if (!profileId) throw new Error(`账号 ${account.name} 缺少 profileId（AdsPower环境ID，环境列表里的"序号"旁边那串数字）`);
      const data = await call('/api/v1/browser/start', { user_id: profileId, open_tabs: 1 });
      const wsEndpoint = data?.ws?.puppeteer;
      if (!wsEndpoint) throw new Error(`AdsPower启动环境 ${profileId} 成功，但没有返回puppeteer调试地址，返回内容: ${JSON.stringify(data)}`);
      return { wsEndpoint };
    },

    async stopProfile(account) {
      await call('/api/v1/browser/stop', { user_id: account.profileId });
    },
  };
}
