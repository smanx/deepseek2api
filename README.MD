# DeepSeek to OpenAI API

将 DeepSeek Chat API 转换为 OpenAI 兼容格式的代理服务。

## 功能特性

- ✅ 完全兼容 OpenAI Chat Completions API 格式
- ✅ 支持流式响应 (SSE)
- ✅ 支持多轮对话（自动保持上下文）
- ✅ 支持多账号配置与随机负载均衡
- ✅ 支持 OpenAI 兼容的 API Key 验证
- ✅ 支持 OpenAI 兼容的思考模式（reasoning_effort / thinking）
- ✅ 支持 OpenAI 兼容的网络搜索（web_search_options / tools）
- ✅ 自动 POW 验证
- ✅ 可配置模型映射
- ✅ 可配置日志等级

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

创建 `.env` 文件（可选）：

```env
# 服务端口（默认 3002）
PORT=3002

# 日志等级 (ERROR/WARN/INFO/DEBUG)
LOG_LEVEL=INFO

# API Key 验证（可选，不配置则跳过验证）
API_KEYS=["sk-key1","sk-key2"]
# 或逗号分隔
API_KEYS=sk-key1,sk-key2

# 账号配置
DEEPSEEK_ACCOUNTS=[{"email":"your_email","password":"your_password"}]
# 或密码为空时，使用账号作为密码
DEEPSEEK_ACCOUNTS=[{"email":"your_email"}]
# 或使用逗号分隔格式（账号密码用 | 分隔）
DEEPSEEK_ACCOUNTS=user1|pass1,user2
# 或使用换行分隔格式
DEEPSEEK_ACCOUNTS=user1|pass1
user2

# 模型类型配置（可选）
DEEPSEEK_MODEL_TYPES=["default","expert"]

# 模型映射配置（可选）
# 单个映射
DEEPSEEK_MODEL_MAPPING={"default":"deepseek-v4-flash","expert":"deepseek-v4-pro"}
# 或多个映射（逗号分隔，随机选择）
DEEPSEEK_MODEL_MAPPING={"default":"deepseek-v4-flash,gpt-5.4","expert":"deepseek-v4-pro"}
```

### 启动服务

```bash
npm run dev
```

或

```bash
npm start
```

## Docker 部署

### 构建镜像

```bash
docker build -t deepseek2api .
```

### 运行容器

```bash
docker run -d \
  --name deepseek2api \
  -p 3002:3002 \
  -e DEEPSEEK_ACCOUNTS='[{"email":"your_email","password":"your_password"}]' \
  deepseek2api
```

### 使用环境变量文件

```bash
docker run -d \
  --name deepseek2api \
  -p 3002:3002 \
  --env-file .env \
  deepseek2api
```

### Docker Compose

创建 `docker-compose.yml`：

```yaml
version: '3.8'
services:
  deepseek2api:
    build: .
    ports:
      - "3002:3002"
    environment:
      - PORT=3002
      - DEEPSEEK_ACCOUNTS=[{"email":"your_email","password":"your_password"}]
    restart: unless-stopped
```

运行：

```bash
docker-compose up -d
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全接口 |
| `/v1/models` | GET | 获取可用模型列表 |
| `/health` | GET | 健康检查 |

## 使用示例

### 非流式请求

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "default",
    "messages": [
      {"role": "user", "content": "你好"}
    ]
  }'
```

### 流式请求

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "default",
    "messages": [
      {"role": "user", "content": "你好"}
    ],
    "stream": true
  }'
```

> 如果未配置 `API_KEYS`，则不需要 `Authorization` 头。

### 使用 OpenAI SDK

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3002/v1',
  apiKey: 'sk-your-api-key' // 如果未配置 API_KEYS，可设为任意值
});

const response = await client.chat.completions.create({
  model: 'default',
  messages: [{ role: 'user', content: '你好' }],
  stream: true
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

## 默认模型

| Model ID | Model Type | 说明 |
|----------|------------|------|
| `default` | default | 默认模型 |
| `expert` | expert | 专家模型 |

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务端口 | `3002` |
| `LOG_LEVEL` | 日志等级 (ERROR/WARN/INFO/DEBUG) | `INFO` |
| `API_KEYS` | API Key 列表 (JSON 数组或逗号分隔) | 无（跳过验证） |
| `DEEPSEEK_ACCOUNTS` | 账号列表 (JSON数组/逗号分隔/换行分隔) | 无 |
| `DEEPSEEK_ACCOUNTS_URL` | 远程获取账号列表的 URL（优先级高于 DEEPSEEK_ACCOUNTS） | 无 |
| `DEEPSEEK_MODEL_TYPES` | 可用模型类型列表 | `["default", "expert"]` |
| `DEEPSEEK_MODEL_MAPPING` | 模型类型到模型 ID 的映射 | `{}` |

## 注意事项

1. 此服务需要 DeepSeek 账号才能正常工作
2. 启动时会验证所有账号并清除旧缓存
3. 多账号会随机负载均衡
4. 建议在生产环境中使用 HTTPS

## 响应头说明

每个 `/v1/chat/completions` 请求的响应都会包含以下自定义响应头：

| 响应头 | 说明 | 示例 |
|--------|------|------|
| `X-Account-Total` | 配置的账号总数 | `2` |
| `X-Account-Success` | 成功登录的账号数 | `1` |
| `X-Account-Index` | 当前使用的账号索引（0-based） | `0` |
| `X-Account-Id` | 当前使用的账号ID（email） | `user@qq.com` |

## 多轮对话

服务自动支持多轮对话。当客户端发送包含历史消息的请求时，服务会将所有消息格式化后发送给 DeepSeek API。

**工作原理：**

1. 所有历史消息被格式化为特殊格式的 prompt
2. 每次请求都创建新的会话
3. DeepSeek API 会根据完整的上下文生成响应

**示例：**

```javascript
const messages = [
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好！有什么可以帮助你的吗？' },
  { role: 'user', content: '今天天气怎么样？' }
];

// 服务会自动将所有消息格式化后发送
```

## 多账号负载均衡

当配置多个账号时，服务会自动进行负载均衡：

1. **随机选择**：每次请求随机选择一个可用账号
2. **故障转移**：账号登录失败时自动尝试其他账号
3. **状态追踪**：失败的账号会被标记，后续请求自动跳过

**配置示例：**
```env
DEEPSEEK_ACCOUNTS=[{"email":"user1@qq.com","password":"pass1"},{"email":"user2@qq.com","password":"pass2"}]
```

## 思考模式

服务支持 OpenAI 兼容的思考模式参数，启用后模型会先输出思考过程，再输出最终回答。

### 启用方式

**方式一：使用 `reasoning_effort` 参数**

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "解释相对论"}],
    "reasoning_effort": "high"
  }'
```

**方式二：使用 `thinking` 参数**

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "解释相对论"}],
    "thinking": {"type": "enabled"}
  }'
```

### 参数说明

| 参数 | 值 | 说明 |
|------|---|------|
| `reasoning_effort` | `low`, `medium`, `high`, `max` | 思考强度，设置后自动启用思考模式 |
| `thinking.type` | `enabled`, `disabled` | 思考模式开关 |

### 响应格式

启用思考模式后，响应中会包含 `reasoning_content` 字段：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "最终回答内容",
      "reasoning_content": "思考过程内容"
    },
    "finish_reason": "stop"
  }]
}
```

### 流式响应

流式模式下，思考内容通过 `delta.reasoning_content` 字段返回：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "content": "",
      "reasoning_content": "思考内容片段"
    }
  }]
}
```

## 搜索模式

服务支持 OpenAI 兼容的网络搜索参数，启用后模型可以搜索网络获取最新信息。

### 启用方式

**方式一：使用 `web_search_options` 参数**

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "今天新闻"}],
    "web_search_options": {}
  }'
```

**方式二：使用 `tools` 参数**

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "今天新闻"}],
    "tools": [{"type": "web_search"}]
  }'
```

### 参数说明

| 参数 | 格式 | 说明 |
|------|------|------|
| `web_search_options` | `{}` 或详细配置 | OpenAI Chat Completions API 的搜索选项 |
| `tools` | `[{"type": "web_search"}]` | OpenAI Responses API 的搜索工具 |

### 组合使用

思考模式和搜索模式可以同时启用：

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "分析最新的AI发展趋势"}],
    "reasoning_effort": "high",
    "web_search_options": {}
  }'
```

## License

MIT
