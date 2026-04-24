# DeepSeek to OpenAI API

将 DeepSeek Chat API 转换为 OpenAI 兼容格式的代理服务。

## 功能特性

- ✅ 完全兼容 OpenAI Chat Completions API 格式
- ✅ 支持流式响应 (SSE)
- ✅ 支持多轮对话（自动保持上下文）
- ✅ 支持多账号配置与随机负载均衡
- ✅ 支持 OpenAI 兼容的 API Key 验证
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

# 账号配置（二选一）
DEEPSEEK_ACCOUNTS=[{"email":"your_email","password":"your_password"}]
# 或
DEEPSEEK_EMAIL=your_email
DEEPSEEK_PASSWORD=your_password

# 模型类型配置（可选）
DEEPSEEK_MODEL_TYPES=["default","expert"]

# 模型映射配置（可选）
DEEPSEEK_MODEL_MAPPING={"default":"deepseek-v4-flash","expert":"deepseek-v4-pro"}
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
| `DEEPSEEK_ACCOUNTS` | 账号列表 (JSON 格式) | 无 |
| `DEEPSEEK_EMAIL` | 单个账号邮箱 | 无 |
| `DEEPSEEK_PASSWORD` | 单个账号密码 | 无 |
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

## License

MIT
