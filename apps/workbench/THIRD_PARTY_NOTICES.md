# 第三方源码说明

交互终端使用 [ttyd](https://github.com/tsl0922/ttyd)，MIT 许可，以宿主机可执行程序运行，不复制其浏览器构建产物。ttyd 自带的终端前端及其依赖许可由对应发行包保留。平台使用 `ws`（MIT）转发 ttyd 协议，并在每条消息转发前检查任务状态。

旧监控组件来自用户指定的本机项目 `/Users/wh4lter/Workspace/web-terminal-monitor`。`vendor/web-terminal-monitor-0.2.0.tgz` 仅作为回退档案保留，SHA-256 为 `c1b4f3770e81b9580d127b1252af64dc487fecbbf0a801c2832568c436d7f914`，不再参与安装、构建或运行。旧浏览器依赖许可保留于 `vendor/audit-monitor-LICENSES.txt`。

`app/components/ui/button.tsx`、`dialog.tsx`、`tabs.tsx`、`badge.tsx` 来自 [shadcn/ui](https://github.com/shadcn-ui/ui) 的 new-york registry，于 2026-10-01 获取，遵循 MIT 许可。

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
