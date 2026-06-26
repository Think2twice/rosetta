# OpenAI-compatible gateway

这个目录放的是一个薄封装：用 Rosetta 驱动已经登录的 ChatGPT 网页，再把外层接口做成 OpenAI 风格。

它适合自用网关、Open WebUI 这类本地工具，或者想把 ChatGPT 网页能力接到现有脚本里的场景。它不是 OpenAI 官方 API，也不会绕过 ChatGPT 网页本身的限制。网页账号能做什么，它才有机会做什么。

## 这层多做了什么

Rosetta 本体负责把消息发进 ChatGPT 网页，并把文本结果带回来。这个示例在它外面补了几件事：

- 提供 `/v1/chat/completions`，普通文本请求可以按 OpenAI Chat Completions 的形状调用。
- 支持 `messages[].content` 里的 `image_url` 和 `input_image`，会把图片保存成本地临时文件，再作为附件交给 ChatGPT 网页。
- 图片生成或图片编辑完成后，不只看页面上的 `<img>`。如果页面没有直接暴露图片 URL，会去会话 JSON 里找 `image_asset_pointer`，再用 ChatGPT 的 `files/download` 路由换成可下载地址。
- 把生成图落到本地 `/data/generated-images`，再通过 `/v1/rosetta/images/<id>` 对外给一个稳定 URL。
- 带一个浏览器版 noVNC 页面，方便你在服务器上完成 ChatGPT 登录。

## 文件

```text
examples/openai-compatible-gateway/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── start.sh
├── server.mjs
└── README.md
```

`server.mjs` 是网关本体。`start.sh` 负责启动 Xvfb、Chromium、noVNC 和 Node 服务。`Dockerfile` 从当前仓库源码构建 Rosetta，所以这里包含了本 fork 里的上传和 focus 修复，不需要在容器启动时再打热补丁。

## 先准备登录

复制环境文件：

```bash
cd examples/openai-compatible-gateway
cp .env.example .env
```

把 `.env` 里的 `ROSETTA_API_KEY` 换成你自己的随机值。一个简单做法：

```bash
openssl rand -hex 32
```

启动：

```bash
docker compose up -d --build
```

如果服务跑在远程机器上，不要把 noVNC 暴露公网。用 SSH 隧道看浏览器：

```bash
ssh -L 16084:127.0.0.1:13284 user@your-server
```

然后在本机浏览器打开：

```text
http://127.0.0.1:16084/vnc.html?autoconnect=true&resize=scale
```

在这个浏览器里登录 `chatgpt.com`。登录态会保存在 `examples/openai-compatible-gateway/data/chrome-profile`，容器重启后还能继续用。

## 健康检查

```bash
curl http://127.0.0.1:13283/health
```

能用时大致是这样：

```json
{
  "status": "ok",
  "cdp": { "ok": true },
  "auth": { "ok": true }
}
```

`cdp.ok` 说明浏览器调试端口可用。`auth.ok` 说明 Rosetta 能打开已登录的 ChatGPT 页面。

## 文本请求

```bash
KEY="<YOUR_LOCAL_GATEWAY_KEY>"

curl http://127.0.0.1:13283/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "user", "content": "Reply with one short sentence." }
    ]
  }'
```

模型名会做一层映射：

```text
gpt-5.5          -> gpt-5-5
gpt-5.5-pro      -> gpt-5-5-pro
gpt-5.5-thinking -> gpt-5-5-thinking
```

不要用“你是 GPT 几”当作唯一判断。网页里的模型自报可能和页面左上角选择的档位不一致。更可靠的是看返回里的 `rosetta.modelSlug`，再配合实际能力和日志判断。

## 图片编辑请求

请求里放一张图片：

```bash
KEY="<YOUR_LOCAL_GATEWAY_KEY>"

curl http://127.0.0.1:13283/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "return_images": true,
    "timeout_ms": 1200000,
    "idle_timeout_ms": 300000,
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Turn this image into a clean 3D animated film still. Keep the original composition."
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://example.com/input.png"
            }
          }
        ]
      }
    ]
  }'
```

返回里如果成功，会有：

```json
{
  "images": [
    {
      "url": "http://127.0.0.1:13283/v1/rosetta/images/<id>.png",
      "content_type": "image/png"
    }
  ],
  "rosetta": {
    "modelSlug": "gpt-5-5",
    "conversationId": "...",
    "inputImages": 1
  }
}
```

如果你把服务放到反向代理后面，把 `.env` 里的 `ROSETTA_PUBLIC_BASE_URL` 改成公网入口。不要把 API key 写进 README、issue、截图或日志。

## 生成图片

也可以走 `/v1/images/generations`：

```bash
KEY="<YOUR_LOCAL_GATEWAY_KEY>"

curl http://127.0.0.1:13283/v1/images/generations \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "prompt": "A small wooden desk by a rainy window, 3D animated film style."
  }'
```

这个接口最终还是通过 ChatGPT 网页生成图片，不是官方 Images API。调用频率按网页账号的实际限制来。

## 图片返回为什么要走会话 JSON

ChatGPT 图片任务有时不会在页面 DOM 里直接留下可抓的最终图片 URL。网页会话 JSON 里会有一段 `image_asset_pointer`，形式通常像：

```text
sediment://file_...
```

网关会把它变成文件 ID，然后调用：

```text
/backend-api/files/download/<file_id>?conversation_id=<conversation_id>&inline=true
```

拿到 `download_url` 后再下载图片，保存成本地文件。这样比只扫页面上的 `<img>` 稳一点，尤其是图片编辑、排队生成、页面懒加载这些情况。

## 两个补丁

这个 fork 对 Rosetta 本体改了两处，都是为了让服务器里的无头图形环境更稳。

第一处在 `src/client.ts`。Xvfb 或某些窗口管理器里，`Page.bringToFront()` 之后 `document.hasFocus()` 可能一直是 false。以前这里会直接抛 `Could not bring tab to front`。现在不在这个点硬失败，而是继续走后面的 DOM 输入兜底。

第二处在 `src/upload.ts`。图片附件上传后，ChatGPT 经常只显示缩略图，不显示带文件名的 chip。以前 Rosetta 等不到文件名 chip，就会误判超时。现在图片附件会优先找图片上传 input，并且把“用户上传图片”的缩略图也当成 ready 信号。

## 安全边界

这里有三个端口：

```text
13283 -> OpenAI-compatible API
13284 -> noVNC
13285 -> Chrome DevTools Protocol
```

默认 `docker-compose.yml` 只绑定 `127.0.0.1`。保持这个习惯。尤其是 noVNC 和 CDP，不要直接暴露到公网。公网入口只应该放 API 层，并且要有反向代理、HTTPS 和鉴权。

生成图存在：

```text
examples/openai-compatible-gateway/data/generated-images
```

上传图片的临时副本存在：

```text
examples/openai-compatible-gateway/data/uploads/openai
```

如果图片里有隐私内容，记得按自己的保留策略清理这些目录。

## 常见问题

`auth.ok` 是 false  
先打开 noVNC，看 ChatGPT 是否还在登录态。如果页面要求重新登录，登录完再测 `/health`。

`images` 为空  
先看 `rosetta.conversationId` 是否存在。存在的话，通常是生成图还没进入会话 JSON，或者文件下载路由拒绝了当前登录态。看容器日志里的 `conversation image extraction skipped`。

图片上传超时  
看图片大小和格式。示例默认单张输入图限制是 20 MB。也要确认模型当前页面支持图片输入。

生成慢  
这是网页任务本身慢。不要用很短的 HTTP timeout。图片编辑建议 `timeout_ms` 至少给十几分钟，`idle_timeout_ms` 给几分钟。

模型自报不对  
不要急着换网关。ChatGPT 自报模型名经常不可靠。先看页面档位、请求里的 model、返回里的 `rosetta.modelSlug`，再看实际能力表现。

## 本地验证

不登录 ChatGPT 也可以先做语法和单元测试：

```bash
pnpm install
pnpm test
pnpm build
```

真正的端到端测试需要：

1. 容器启动。
2. noVNC 里登录 ChatGPT。
3. `/health` 里 `auth.ok` 为 true。
4. 发一条 `/v1/chat/completions` 请求。
5. 如果是图片任务，再检查返回的 `/v1/rosetta/images/<id>` 能否下载。
