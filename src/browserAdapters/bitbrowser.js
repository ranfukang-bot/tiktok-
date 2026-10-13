// 比特浏览器 (BitBrowser) 本地API：客户端在本机起一个 http://127.0.0.1:54345 的服务
// （具体端口以客户端「系统设置」里显示的为准，免费版目前就能用，不需要升级套餐）。
// 接口信息来自官方文档 https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou：
//   POST /browser/open   body: { id }               -> { success, data: { ws, http, ... } }
//   POST /browser/close  body: { id }
//   POST /browser/list   body: { page, pageSize }    -> 环境列表（用于网页上按名字选账号，不用手抄ID）
export function createBitBrowserAdapter(settings, { request = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const baseUrl = (settings.baseUrl || 'http://127.0.0.1:54345').replace(/\/$/, '');

  async function post(pathname, body = {}, timeoutMs = 120000) {
    let res;
    try {
      res = await request(baseUrl + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`连不上比特浏览器本地API (${baseUrl})：${err.message}。请确认比特浏览器客户端已经打开，并去客户端「系统设置」核对本地API地址/端口是否和全局设置里填的一致。`);
    }
    if (!res.ok) throw new Error(`比特浏览器接口 ${pathname} HTTP ${res.status}（本地API地址不对的话，去客户端「系统设置」核对端口）`);
    const json = await res.json();
    if (!json.success) {
      const error = new Error(`比特浏览器接口 ${pathname} 返回错误: ${json.msg || JSON.stringify(json)}`);
      if (pathname === '/browser/open' && /Client network socket disconnected before secure TLS connection was established/i.test(json.msg || '')) {
        error.code = 'BITBROWSER_START_TLS';
      }
      throw error;
    }
    return json.data;
  }

  // 官方 /browser/ports 返回环境ID到调试端口的映射。仅复用本账号已打开的环境，
  // 并核验端口可连接，避免每次重试都再次触发比特的打开/同步过程。
  async function alreadyOpen(id) {
    try {
      const ports = await post('/browser/ports', {}, 5000);
      const port = Number(ports?.[id]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
      const endpoint = new URL(baseUrl);
      endpoint.port = String(port);
      endpoint.pathname = '/'; endpoint.search = ''; endpoint.hash = '';
      const http = endpoint.origin;
      const response = await request(http + '/json/version', { signal: AbortSignal.timeout(3000) });
      if (!response.ok || !(await response.json()).webSocketDebuggerUrl) return null;
      return { wsEndpoint: http, reused: true };
    } catch { return null; } // 旧版客户端不支持查询时继续原来的打开路径
  }

  // 不同版本 /browser/list 的返回结构可能是 data 直接是数组，也可能包在 list/rows 字段里，做个兼容提取。
  function extractList(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.list)) return data.list;
    if (Array.isArray(data?.rows)) return data.rows;
    return [];
  }

  return {
    name: 'bitbrowser',

    async startProfile(account) {
      const id = account.browserId;
      if (!id) throw new Error(`账号 ${account.name} 缺少 browserId（比特浏览器环境ID）`);
      const existing = await alreadyOpen(id);
      if (existing) return existing;
      let data;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { data = await post('/browser/open', { id }); break; }
        catch (err) {
          // 仅明确的启动TLS业务失败短重试；请求超时等结果不明情况交给外层退避。
          if (err.code !== 'BITBROWSER_START_TLS') throw err;
          const opened = await alreadyOpen(id);
          if (opened) return opened;
          if (attempt === 2) {
            err.message += '。故障发生在比特启动环境阶段，尚未上传视频；短重试仍失败，请检查比特客户端的网络/代理连接，随后按发布器退避策略重试。';
            throw err;
          }
          await delay(attempt === 0 ? 2000 : 5000);
        }
      }
      const wsEndpoint = data?.ws || (data?.http ? `http://${data.http}` : null);
      if (!wsEndpoint) {
        throw new Error(`比特浏览器打开环境 ${id} 成功，但没有返回ws/http调试地址，实际返回: ${JSON.stringify(data)}`);
      }
      return { wsEndpoint };
    },

    async stopProfile(account) {
      await post('/browser/close', { id: account.browserId });
    },

    // 供网页控制台"从比特浏览器读取环境列表"按钮使用，最多翻5页（500个）。
    async listProfiles() {
      const all = [];
      for (let page = 0; page < 5; page += 1) {
        const data = await post('/browser/list', { page, pageSize: 100 });
        const items = extractList(data);
        all.push(...items.map((it) => ({ id: it.id, name: it.name || '', seq: it.seq, remark: it.remark || '' })));
        if (items.length < 100) break;
      }
      return all;
    },
  };
}
