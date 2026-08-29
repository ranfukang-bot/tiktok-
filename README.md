# TikTok Studio 批量发布 · 外部编排器

替代原来那份装在每个指纹浏览器里的油猴脚本(`TikTokStudioBulkUploadV2`)。

## 为什么换掉油猴脚本

油猴脚本跑在每一个指纹浏览器的页面里，逻辑和状态都分散在各个浏览器实例里，每次改代码
都要把新版本重新装/更新到每一个指纹浏览器，账号一多就很难维护。

这里改成：只在你的控制机上跑一个 Node.js 进程，通过指纹浏览器厂商提供的"本地API"拿到
每个账号窗口的 CDP 调试地址，再用 Playwright 连上去远程操作——跟油猴脚本操作同一个
已登录、已经带好指纹的浏览器窗口，效果一样，但代码只有一份，改一次全账号生效，不需要
再往任何浏览器里装/更新插件。原脚本里那些踩过坑的细节（Draft.js文案安全清空、商品挂车
多步弹窗、发布前后的各种检测/校验）基本原样保留在 `src/browser/injected.js` 里。

## 目录结构

```
config/
  settings.example.json   全局默认配置（复制成 settings.json 后改）
  accounts.example.json   账号列表（复制成 accounts.json 后改）
src/
  index.js                CLI 入口: run / resolve
  orchestrator.js          调度循环：扫描各账号文件夹、判断是否到点、跑一轮发布
  stateStore.js             每个账号的进度状态，存成 state/<账号名>.json
  folderScanner.js          扫描视频文件夹、文件名->商品ID、增量对比队列
  browserAdapters/          adspower.js / hubstudio.js：跟指纹浏览器本地API对接，拿CDP地址
  browser/
    injected.js              注入到 TikTok Studio 页面里跑的自动化逻辑（原脚本核心搬过来的）
    tiktokStudio.js           Node端用 Playwright 驱动一次完整的"传视频->发布"流程
state/                     运行时生成的每账号进度文件（不进git）
```

## 安装

```bash
npm install
cp config/settings.example.json config/settings.json
cp config/accounts.example.json config/accounts.json
```

然后编辑这两个文件。

## AdsPower 账号配置

1. AdsPower 客户端里打开"本地API"（团队版功能），确认端口是 50325（默认）。
2. `accounts.json` 里对应账号填 `"browser": "adspower"` 和 `"profileId"`（环境列表里那个ID，
   截图里"序号"旁边那一串数字）。

## Hubstudio 账号配置 —— 这部分需要你确认一下

Hubstudio 官方接口文档站在当前环境里访问不到，`src/browserAdapters/hubstudio.js` 里的
接口路径/字段名是按公开资料拼的最佳猜测（不保证100%准确）。用之前请：

1. 打开 Hubstudio 客户端 → 左侧「开发者」（就是你截图里能看到的那个入口）
2. 找到"打开环境/启动浏览器"接口的文档，核对：
   - 请求路径和方法（代码里默认 `POST /api/v1/browser/open`）
   - 环境ID的请求体字段名（代码里默认 `containerCode`）
   - 返回值里调试端口的字段名（代码里默认 `data.debuggingPort`）
3. 如果对不上，不用改代码，改 `config/settings.json` 里的 `hubstudio` 段落：
   ```json
   "hubstudio": {
     "baseUrl": "http://127.0.0.1:6873",
     "openPath": "/api/v1/browser/open",
     "requestIdField": "containerCode",
     "responseDebugPortField": "debuggingPort"
   }
   ```
4. `accounts.json` 里对应账号填 `"browser": "hubstudio"` 和 `"containerCode"`（环境ID）。

第一次跑的时候留意日志：如果返回的JSON里确实没有猜对的字段名，报错信息会把接口实际返回的
内容打印出来，照着改一下配置就行。

## 界面文案要跟账号实际语言对上

`config/settings.json` 里 `text` 段落的按钮文字是照着印尼语界面(Bahasa Indonesia)扒的，
跟"账号是哪个国家"没关系，跟"TikTok Studio 实际显示的语言"有关系。如果某个账号的
TikTok Studio 界面是英文/马来文，要在 `accounts.json` 那个账号下加 `textOverrides`
覆盖对应文字，`accounts.example.json` 里"菲律宾1号"就是英文界面的例子。不覆盖的话，
脚本会因为按钮文字对不上而找不到元素，直接报错暂停（不会瞎点）。

## 运行

```bash
npm start          # 等价于 node src/index.js run
```

会一直跑在前台，按账号各自的随机间隔(默认1.5~2.5小时，settings.json 里可调)轮流发布。
建议用 `pm2` / `systemd` / `screen` 之类的方式常驻后台。

`config/settings.json` 里的 `concurrency` 控制同时打开几个指纹浏览器窗口一起跑，默认1
(完全串行，最稳)。

## 人工介入的场景

- **`uncertain_publish`**：点了发布按钮后45秒内没检测到跳转到内容页，结果不确定，脚本会
  暂停这个账号（不会自动重试，避免重复发布）。你打开对应指纹浏览器人工看一眼TikTok内容
  列表，确认后运行：
  ```bash
  node src/index.js resolve "账号名" --published   # 其实发布成功了，跳到下一条
  node src/index.js resolve "账号名" --retry        # 没发布成功，重试当前这条
  ```
- **其它报错暂停**（比如文案没清空干净、商品没选中、找不到某个按钮）：日志会打印具体原因，
  账号名对应的 `state/<账号名>.json` 里 `pauseReason` 也有记录。排查完手动把该文件里的
  `paused` 改成 `false`（或者删掉这个状态文件重新扫描）即可恢复。

## 和原油猴脚本的行为差异

- 文件夹扫描直接用 Node 的文件系统权限，不需要浏览器的"选择文件夹"授权弹窗。
- 发布完成后回到上传页，优先复用原脚本"点击左侧上传按钮"的方式（更像真人操作），失败了
  下一轮会退回直接跳转链接。
- 原脚本里"暂停当前任务"的面板按钮在这个版本里去掉了；单次上传流程执行中途不支持从外部
  打断，如果要临时停手，等当前这条跑完，再把对应账号在 `accounts.json` 里 `enabled` 设成
  `false` 或者把状态文件标成 `paused`。
