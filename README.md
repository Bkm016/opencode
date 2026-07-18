<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">开源 AI Coding Agent。</p>
<p align="center">
  <a href="https://github.com/Bkm016/opencode"><img alt="Fork" src="https://img.shields.io/badge/fork-Bkm016-blue?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode"><img alt="Upstream" src="https://img.shields.io/badge/upstream-anomalyco%2Fopencode-gray?style=flat-square" /></a>
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

> [anomalyco/opencode](https://github.com/anomalyco/opencode) 的个人 fork（[Bkm016/opencode](https://github.com/Bkm016/opencode)）。**非官方**，与 OpenCode 团队无隶属关系。

---

### 这是什么

OpenCode 是开源 AI 编程助手，支持终端（TUI）、桌面应用与 Web，可对接多种模型提供商。

官方文档：https://opencode.ai/docs

---

### 本 Fork 核心改动

- **移除逆天新布局** — 去掉 `newLayout` / v2 双路径，只保留一套统一布局
- **异步任务工具** — `task_async` 批量拉起子会话，支持 status / wait / followup
- **内置提示词编辑** — 设置里覆盖 system / agent / tool / compaction 等内置 prompt
- **配置热重载** — 改配置后 `/reload` 立即生效
- **流式重试** — 传输中断、不完整流、0-token 结束等自动重试
- **会话置顶 / 归档** — 侧栏 pin；归档会话可找回
- **子会话** — 侧栏展示运行中子会话；会话内可浏览 child session
- **用户消息重放** — 对已发用户消息 replay
- **会话内查找** — `Ctrl+F` 搜索聊天时间线
- **Context 用量分布** — 展示 prompt / tool token 占比
- **权限旁路开关** — 输入区一键 bypass permission
- **本地数据库清理** — 查看库体量，安全清理过期 tool 输出与日志
- **Windows Shell UTF-8** — PowerShell 中文输出不乱码

---

### 文档与贡献

- https://opencode.ai/docs
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- 本 fork 问题请开到 [Bkm016/opencode](https://github.com/Bkm016/opencode)

---

**上游社区** [Discord](https://opencode.ai/discord) · [X](https://x.com/opencode) · [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=52ao9352-5623-4fa0-b7dd-3407c392c1af&qr_code=true)
