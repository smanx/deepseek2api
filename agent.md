# DeepSeek to OpenAI API 项目说明

## ⚠️ 重要提示

**请用户手动运行以下命令启动服务，Agent 不要自动运行：**

```bash
npm run dev
```

> 🔴 **禁止 Agent 自动执行**：Agent 不应该自己运行 `npm run dev` 或 `node src/index.js` 命令，必须由用户手动启动服务器。

---

## 环境变量配置

> `.env` 文件是**可选的**，程序在没有环境变量时也能正常启动。

在项目根目录创建 `.env` 文件（可选）：

### 服务配置

```
PORT=3002
LOG_LEVEL=INFO
API_KEYS=["sk-key1","sk-key2"]
```

> 默认端口: 3002
> 日志等级: ERROR, WARN, INFO, DEBUG (默认 INFO)
> API Key: 可选，支持 JSON 数组或逗号分隔格式，不配置则跳过验证

### 账号配置

```
DEEPSEEK_ACCOUNTS=[{"email":"your_email","password":"your_password"}]
```

或者：

```
DEEPSEEK_EMAIL=your_email
DEEPSEEK_PASSWORD=your_password
```

> 如果没有配置账号，服务会启动但请求会返回认证错误。

### 模型配置（可选）

```
# 配置可用的 model_type 列表（JSON数组或逗号分隔）
DEEPSEEK_MODEL_TYPES=["default","expert"]

# 配置 model_type 到 model id 的映射（只有配置了才生效）
DEEPSEEK_MODEL_MAPPING={"default":"deepseek-v4-flash","expert":"deepseek-v4-pro"}
```

**默认配置：**
- `model_types`: `["default", "expert"]`
- `model_mapping`: 无默认值，只有配置了环境变量才映射

**说明：**
- 当请求的 `model` 参数匹配映射中的 model id 时，会使用对应的 `model_type`
- 当请求的 `model` 参数没有映射时，直接作为 `model_type` 使用
- 响应中的 `model` 字段会显示映射后的 model id（如果配置了映射）

## API 端点

- **Chat Completions**: `POST http://localhost:{PORT}/v1/chat/completions`
- **Models**: `GET http://localhost:{PORT}/v1/models`
- **Health**: `GET http://localhost:{PORT}/health`

## 默认支持的模型

- `default` - 默认模型
- `expert` - 专家模型

## 测试请求示例

```bash
curl -X POST http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}]}'
```

---

## 日志等级说明

| 等级 | 值 | 说明 |
|------|---|------|
| `ERROR` | 0 | 只输出错误信息 |
| `WARN` | 1 | 输出错误和警告 |
| `INFO` | 2 | 输出错误、警告和信息（默认） |
| `DEBUG` | 3 | 输出所有日志，包括调试信息 |

**使用方法：**
```bash
LOG_LEVEL=DEBUG npm run dev
```

---

## POW 验证机制

### 工作流程

1. **每次请求都重新获取 POW**：不缓存 POW，确保每次请求都有有效的验证
2. **复用 authorization**：账号登录后保存 authorization，后续请求复用
3. **失败重试**：POW 验证失败时自动重新获取并重试

### 相关文件

- `src/pow_wasm.js` - POW 计算逻辑
- `src/sha3_wasm_bg.*.wasm` - WASM 二进制文件

---

## 响应头说明

每个 `/v1/chat/completions` 请求的响应都会包含以下自定义响应头：

| 响应头 | 说明 | 示例 |
|--------|------|------|
| `X-Account-Total` | 配置的账号总数 | `2` |
| `X-Account-Success` | 成功登录的账号数 | `1` |
| `X-Account-Index` | 当前使用的账号索引（0-based，从0开始） | `0` |
| `X-Account-Id` | 当前使用的账号ID（email） | `user@qq.com` |

**示例响应头：**
```
X-Account-Total: 2
X-Account-Success: 1
X-Account-Index: 0
X-Account-Id: 497704568@qq.com
```

---

## 账号状态管理

### 启动时验证

服务启动时会验证所有配置的账号，并保存状态到 `.auth-cache.json`：

```
配置了 2 个账号，正在验证...

验证账号: user1@qq.com
账号 user1@qq.com 验证成功!

验证账号: user2@qq.com
账号 user2@qq.com 验证失败: 密码错误

账号状态:
  1. user1@qq.com - ✓ 正常
  2. user2@qq.com - ❌ 失败: 密码错误

共 1/2 个账号可用
```

### 缓存文件格式

`.auth-cache.json` 保存每个账号的状态：

```json
[
  {
    "email": "user1@qq.com",
    "authorization": "xxx",
    "device_id": "xxx",
    "timestamp": 1234567890,
    "failed": false,
    "error": null
  },
  {
    "email": "user2@qq.com",
    "authorization": null,
    "device_id": null,
    "timestamp": 1234567890,
    "failed": true,
    "error": "密码错误"
  }
]
```

### 账号选择策略

- 随机选择账号时自动排除失败的账号
- 登录失败时自动尝试其他可用账号
- 所有账号都失败时返回认证错误

---

## WASM 文件说明

### 文件用途

`src/sha3_wasm_bg.7b9ca65ddd.wasm` 用于 POW (Proof of Work) 验证计算，是 DeepSeek API 安全验证的核心组件。

### 文件来源

WASM 文件来自 `@ziuchen/deepseek-api` npm 包，位于：
```
node_modules/@ziuchen/deepseek-api/dist/sha3_wasm_bg.7b9ca65ddd.wasm
```

### 如何获取/更新

**方法一：通过 npm 临时安装**
```bash
# 临时安装获取 WASM 文件
npm install @ziuchen/deepseek-api
cp node_modules/@ziuchen/deepseek-api/dist/sha3_wasm_bg.*.wasm src/
# 然后可以卸载（WASM 文件已复制）
npm uninstall @ziuchen/deepseek-api
```

**方法二：从 DeepSeek 网站获取**
1. 打开 https://chat.deepseek.com/
2. 打开浏览器开发者工具 (F12) -> Network 标签
3. 刷新页面，搜索 `sha3_wasm` 相关的 wasm 文件
4. 下载并保存到 `src/` 目录

### 失效后的处理

如果 WASM 文件失效（如文件名哈希值变化），会出现以下症状：
- POW 验证失败
- 请求返回 `INVALID_POW_RESPONSE` 错误

**更新步骤：**
1. 检查 `@ziuchen/deepseek-api` 包是否有更新版本
2. 或从 DeepSeek 网站获取最新的 WASM 文件
3. 更新 `src/pow_wasm.js` 中的文件名（如果文件名变化）
4. 重启服务

**文件名格式：**
```
sha3_wasm_bg.{hash}.wasm
```
其中 `{hash}` 是版本哈希值，可能会随 DeepSeek 更新而变化。
