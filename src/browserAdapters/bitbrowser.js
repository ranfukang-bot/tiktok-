// 比特浏览器 (BitBrowser) 本地API：客户端在本机起一个 http://127.0.0.1:54345 的服务
// （具体端口以客户端「系统设置」里显示的为准，免费版目前就能用，不需要升级套餐）。
// 接口信息来自官方文档 https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou：
//   POST /browser/open   body: { id }               -> { success, data: { ws, http, ... } }
//   POST /browser/close  body: { id }
//   POST /browser/list   body: { page, pageSize }    -> 环境列表（用于网页上按名字选账号，不用手抄ID）
export function createBitBrowserAdapter(settings) {
  const baseUrl = (settings.baseUrl || 'http://127.0.0.1:54345').replace(/\/$/, '');

  async function post(pathname, body = {}) {
    let res;
    try {
      res = await fetch(baseUrl + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`连不上比特浏览器本地API (${baseUrl})：${err.message}。请确认比特浏览器客户端已经打开，并去客户端「系统设置」核对本地API地址/端口是否和全局设置里填的一致。`);
    }
    if (!res.ok) throw new Error(`比特浏览器接口 ${pathname} HTTP ${res.status}（本地API地址不对的话，去客户端「系统设置」核对端口）`);
    const json = await res.json();
    if (!json.success) {
      throw new Error(`比特浏览器接口 ${pathname} 返回错误: ${json.msg || JSON.stringify(json)}`);
    }
    return json.data;
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
      const data = await post('/browser/open', { id });
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
