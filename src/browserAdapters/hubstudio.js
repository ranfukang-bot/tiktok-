// Hubstudio 本地API：客户端在本机起一个 http://127.0.0.1:6873 的服务。
// 接口信息已对照官方文档确认（浏览器环境 -> 打开环境 / 关闭环境）：
//   POST /api/v1/browser/start   body: { containerCode, isHeadless, ... }
//   POST /api/v1/browser/stop    body: { containerCode }
//   返回: { code, msg, data: { debuggingPort, ... } }，code === 0 表示成功
//   Authorization 请求头：客户端「开发者」页面里"安全校验"关闭时传 'NULL' 即可；
//   开启了安全校验的话，把客户端里生成的 API Key 填到全局设置里。
export function createHubstudioAdapter(settings) {
  const baseUrl = (settings.baseUrl || 'http://127.0.0.1:6873').replace(/\/$/, '');
  const openPath = settings.openPath || '/api/v1/browser/start';
  const closePath = settings.closePath || '/api/v1/browser/stop';
  const requestIdField = settings.requestIdField || 'containerCode';
  const responseDebugPortField = settings.responseDebugPortField || 'debuggingPort';
  const responseWsField = settings.responseWsField || null; // 如果某个版本返回的直接是完整ws地址，填这个字段名

  async function post(pathname, body) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN',
      Authorization: settings.apiKey || 'NULL',
    };
    const res = await fetch(baseUrl + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Hubstudio接口 ${pathname} HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(`Hubstudio接口 ${pathname} 返回错误: ${json.msg || json.message || JSON.stringify(json)}`);
    }
    return json.data ?? json;
  }

  function readField(obj, dottedField) {
    return dottedField.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  return {
    name: 'hubstudio',

    async startProfile(account) {
      const containerCode = account.containerCode;
      if (!containerCode) throw new Error(`账号 ${account.name} 缺少 containerCode（Hubstudio环境ID）`);
      const body = {
        [requestIdField]: containerCode,
        isHeadless: false,
      };
      const data = await post(openPath, body);

      if (responseWsField) {
        const wsEndpoint = readField(data, responseWsField);
        if (!wsEndpoint) throw new Error(`Hubstudio启动环境 ${containerCode} 成功，但字段 ${responseWsField} 里没有ws地址，实际返回: ${JSON.stringify(data)}`);
        return { wsEndpoint };
      }

      const port = readField(data, responseDebugPortField);
      if (!port) {
        throw new Error(
          `Hubstudio启动环境 ${containerCode} 成功，但没找到调试端口字段 "${responseDebugPortField}"。` +
          ` 实际返回内容: ${JSON.stringify(data)}。请对照客户端「开发者」里的接口文档，` +
          `把正确的字段名填到全局设置里的 Hubstudio 高级设置。`
        );
      }
      // Playwright 的 connectOverCDP 接受 http(s) 地址，会自动去 /json/version 拿真正的 ws 地址。
      return { wsEndpoint: `http://127.0.0.1:${port}` };
    },

    async stopProfile(account) {
      await post(closePath, { [requestIdField]: account.containerCode });
    },
  };
}
