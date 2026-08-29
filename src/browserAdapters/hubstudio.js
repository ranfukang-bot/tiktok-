// Hubstudio 本地API：客户端在本机起一个 http://127.0.0.1:6873 的服务。
//
// ⚠️ 没有验证过的部分：官方文档站(api-docs.hubstudio.cn / support-orig.hubstudio.cn)
// 在当前网络环境下访问不到，下面的默认路径/字段名是根据公开资料拼出来的最佳猜测，
// 不保证和你客户端里实际的接口完全一致。首次使用前请：
//   1. 打开 Hubstudio 客户端 -> 左侧「开发者」（截图里能看到这个入口）
//   2. 找到"打开环境/启动浏览器"这个接口的文档，核对：
//      - 请求路径和方法（下面默认是 POST /api/v1/browser/open）
//      - 请求体里环境ID的字段名（下面默认是 containerCode）
//      - 返回值里调试端口的字段名（下面默认是 data.debuggingPort）
//   3. 如果和默认值不一样，不用改代码，改 config/settings.json 的 hubstudio 段落即可
//      （openPath / requestIdField / responseDebugPortField）。
export function createHubstudioAdapter(settings) {
  const baseUrl = (settings.baseUrl || 'http://127.0.0.1:6873').replace(/\/$/, '');
  const openPath = settings.openPath || '/api/v1/browser/open';
  const closePath = settings.closePath || '/api/v1/browser/close';
  const requestIdField = settings.requestIdField || 'containerCode';
  const responseDebugPortField = settings.responseDebugPortField || 'debuggingPort';
  const responseWsField = settings.responseWsField || null; // 如果返回的直接是完整ws地址，填这个字段名

  async function post(pathname, body) {
    const headers = { 'Content-Type': 'application/json' };
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
        groupCode: account.groupCode || settings.groupCode || undefined,
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
          `把正确的字段名填到 config/settings.json 的 hubstudio.responseDebugPortField。`
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
