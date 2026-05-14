const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 尝试加载 .env 文件，文件不存在也不报错
try {
  require('dotenv').config();
} catch (e) {
  // .env 文件不存在，忽略
}

// 日志等级配置
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

const logger = {
  error: (...args) => LOG_LEVEL >= LOG_LEVELS.ERROR && console.error('[ERROR]', ...args),
  warn: (...args) => LOG_LEVEL >= LOG_LEVELS.WARN && console.warn('[WARN]', ...args),
  info: (...args) => LOG_LEVEL >= LOG_LEVELS.INFO && console.log('[INFO]', ...args),
  debug: (...args) => LOG_LEVEL >= LOG_LEVELS.DEBUG && console.log('[DEBUG]', ...args),
  log: (...args) => LOG_LEVEL >= LOG_LEVELS.INFO && console.log(...args)
};

// 导入正确的POW WASM实现
const { getPowResponse, loadPowWasm } = require('./pow_wasm.js');

let wasmModule = null;

// 加载WASM模块
async function loadWasmModule() {
  try {
    await loadPowWasm();
    wasmModule = true;
    logger.info('WASM模块加载成功');
  } catch (error) {
    logger.error('WASM模块加载失败:', error);
    wasmModule = null;
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 3002;
const DEEPSEEK_API_URL = 'https://chat.deepseek.com/api/v0/chat/completion';
const LOGIN_URL = 'https://chat.deepseek.com/api/v0/users/login';
const POW_CHALLENGE_URL = 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge';
const CACHE_FILE = './.auth-cache.json';

// API Key 配置
let apiKeys = [];

function loadApiKeys() {
  const keysStr = process.env.API_KEYS;
  if (keysStr) {
    try {
      apiKeys = JSON.parse(keysStr);
      if (!Array.isArray(apiKeys)) {
        apiKeys = [apiKeys];
      }
      // 过滤空值并标准化
      apiKeys = apiKeys.filter(k => k && typeof k === 'string').map(k => k.trim());
    } catch (e) {
      // 尝试逗号分隔格式
      apiKeys = keysStr.split(',').map(k => k.trim()).filter(k => k);
    }
  }
  
  if (apiKeys.length > 0) {
    logger.info(`已配置 ${apiKeys.length} 个 API Key`);
  } else {
    logger.info('未配置 API Key，跳过验证');
  }
}

// API Key 验证中间件
function authenticateApiKey(req, res, next) {
  // 没有配置 API Key 时跳过验证
  if (apiKeys.length === 0) {
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const apiKey = authHeader.startsWith('Bearer ') 
    ? authHeader.slice(7).trim() 
    : req.headers['x-api-key']?.trim();

  if (!apiKey) {
    return res.status(401).json({
      error: {
        message: 'Missing API key. Please provide Authorization: Bearer <key> or X-API-Key header.',
        type: 'invalid_request_error',
        code: 'missing_api_key'
      }
    });
  }

  if (!apiKeys.includes(apiKey)) {
    logger.warn(`无效的 API Key 尝试: ${apiKey.slice(0, 8)}...`);
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    });
  }

  next();
}

// 模型类型配置
let modelTypes = ['default', 'expert'];
let modelMapping = {};

function loadModelConfig() {
  // 加载 model_types 配置
  const modelTypesStr = process.env.DEEPSEEK_MODEL_TYPES;
  if (modelTypesStr) {
    try {
      modelTypes = JSON.parse(modelTypesStr);
    } catch (e) {
      modelTypes = modelTypesStr.split(',').map(t => t.trim());
    }
  }

  // 加载 model_mapping 配置（只有配置了环境变量才映射）
  const modelMappingStr = process.env.DEEPSEEK_MODEL_MAPPING;
  if (modelMappingStr) {
    try {
      modelMapping = JSON.parse(modelMappingStr);
    } catch (e) {
      logger.error('DEEPSEEK_MODEL_MAPPING 解析失败:', e.message);
    }
  }

  logger.info('模型类型:', modelTypes);
  logger.debug('模型映射:', JSON.stringify(modelMapping));
}

function getModelId(modelType) {
  const mapping = modelMapping[modelType];
  if (!mapping) {
    return modelType;
  }
  // 支持数组格式
  if (Array.isArray(mapping)) {
    return mapping[Math.floor(Math.random() * mapping.length)];
  }
  // 支持逗号分隔的字符串格式
  if (typeof mapping === 'string' && mapping.includes(',')) {
    const ids = mapping.split(',').map(id => id.trim());
    return ids[Math.floor(Math.random() * ids.length)];
  }
  return mapping;
}

function getModelTypeFromRequest(model) {
  // 检查是否是映射后的 model id
  for (const [type, ids] of Object.entries(modelMapping)) {
    // 支持数组格式
    if (Array.isArray(ids)) {
      if (ids.includes(model)) {
        return type;
      }
    } else if (typeof ids === 'string') {
      // 支持逗号分隔的字符串格式
      const idList = ids.split(',').map(id => id.trim());
      if (idList.includes(model)) {
        return type;
      }
    }
  }
  // 如果没有映射，直接使用 model 作为 model_type
  return model;
}

// 多轮对话：将消息历史格式化为 prompt
function messagesPrepare(messages) {
  const processed = (messages || []).map((m) => {
    const role = m?.role || '';
    const content = m?.content ?? '';
    let text = '';
    if (Array.isArray(content)) {
      text = content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n');
    } else {
      text = String(content);
    }
    return { role, text };
  });

  if (!processed.length) return '';

  // 合并相邻的同角色消息
  const merged = [processed[0]];
  for (let i = 1; i < processed.length; i++) {
    if (processed[i].role === merged[merged.length - 1].role) {
      merged[merged.length - 1].text += '\n\n' + processed[i].text;
    } else {
      merged.push(processed[i]);
    }
  }

  // 格式化为 DeepSeek 格式
  const parts = [];
  for (let i = 0; i < merged.length; i++) {
    const { role, text } = merged[i];
    if (role === 'assistant') {
      parts.push(`<｜Assistant｜>${text}<｜end▁of▁sentence｜>`);
    } else if (role === 'user' || role === 'system') {
      parts.push(i > 0 ? `<｜User｜>${text}` : text);
    } else {
      parts.push(text);
    }
  }

  return parts.join('').replace(/!\[(.*?)\]\((.*?)\)/g, '[$1]($2)');
}

let accounts = [];
let authCache = [];

async function loadAccounts() {
  let accountsStr = process.env.DEEPSEEK_ACCOUNTS;
  
  // 优先使用本地配置，如果没有本地配置则使用远程 URL
  if (!accountsStr) {
    const accountsUrl = process.env.DEEPSEEK_ACCOUNTS_URL;
    if (accountsUrl) {
      try {
        logger.info(`从远程获取账号配置: ${accountsUrl}`);
        const response = await axios.get(accountsUrl, { timeout: 10000 });
        if (response.data) {
          accountsStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
          logger.info('远程账号配置获取成功');
        }
      } catch (error) {
        logger.error(`远程获取账号配置失败: ${error.message}`);
      }
    }
  }
  
  if (accountsStr) {
    try {
      accounts = JSON.parse(accountsStr);
    } catch (e) {
      // 支持逗号或换行符分隔，账号密码用 | 分隔
      const pairs = accountsStr.split(/[,\n]/);
      accounts = pairs.map(p => {
        const [email, password] = p.split('|');
        const trimmedEmail = email?.trim();
        // 密码为空时，使用账号作为密码
        const trimmedPassword = password?.trim() || trimmedEmail;
        return { email: trimmedEmail, password: trimmedPassword };
      }).filter(acc => acc.email);
    }
  }

  // 处理密码为空的情况
  accounts = accounts.map(acc => ({
    email: acc.email,
    password: acc.password || acc.email
  }));

  logger.info(`加载了 ${accounts.length} 个账号`);
  return accounts.length > 0;
}

function loadAuthCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      authCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (!Array.isArray(authCache)) {
        authCache = [];
      }
    }
  } catch (e) {
    authCache = [];
  }
}

function saveAuthCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(authCache, null, 2));
}

function generateDeviceId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result + '==';
}

async function checkAccountBanned(authorization, email) {
  try {
    const response = await axios.get('https://chat.deepseek.com/api/v0/users/current', {
      headers: {
        'Host': 'chat.deepseek.com',
        'User-Agent': 'DeepSeek/1.0.13 Android/35',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'x-client-platform': 'android',
        'x-client-version': '2.0.13',
        'x-client-locale': 'zh_CN',
        'accept-charset': 'UTF-8',
        'authorization': `Bearer ${authorization}`
      }
    });

    const isMuted = response.data?.data?.biz_data?.chat?.is_muted === 1;
    const muteUntil = response.data?.data?.biz_data?.chat?.mute_until;
    
    if (isMuted) {
      logger.warn(`账号 ${maskEmail(email)} 已被封禁 (is_muted: 1, mute_until: ${muteUntil})`);
      return { banned: true, muteUntil };
    }
    
    return { banned: false };
  } catch (error) {
    logger.error(`检查账号 ${maskEmail(email)} 状态失败:`, error.message);
    return { banned: false, error: error.message };
  }
}

async function login(email, password) {
  try {
    const deviceId = generateDeviceId();

    logger.info(`正在登录 ${maskEmail(email)}...`);

    const response = await axios.post(LOGIN_URL, {
      email: email,
      mobile: '',
      password: password,
      area_code: '',
      device_id: deviceId,
      os: 'android'
    }, {
      headers: {
        'Host': 'chat.deepseek.com',
        'User-Agent': 'DeepSeek/1.0.13 Android/35',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
        'x-client-platform': 'android',
        'x-client-version': '2.0.13',
        'x-client-locale': 'zh_CN',
        'accept-charset': 'UTF-8'
      }
    });

    let token = null;
    if (response.data?.data?.biz_data?.user?.token) {
      token = response.data.data.biz_data.user.token;
    } else if (response.data?.data?.biz_data?.token) {
      token = response.data.data.biz_data.token;
    }

    if (token) {
      // 登录成功后立即检查账号是否被封
      const bannedCheck = await checkAccountBanned(token, email);
      if (bannedCheck.banned) {
        return {
          success: false,
          email: email,
          error: '账号已被封禁'
        };
      }

      return {
        success: true,
        authorization: token,
        device_id: deviceId,
        email: email
      };
    }
    
    // 登录失败，返回错误信息
    const errorMsg = response.data?.msg || response.data?.message || '未知错误';
    return {
      success: false,
      email: email,
      error: errorMsg
    };
  } catch (error) {
    const errorMsg = error.response?.data?.msg || error.response?.data?.message || error.message;
    logger.error(`登录 ${maskEmail(email)} 失败:`, errorMsg);
    return {
      success: false,
      email: email,
      error: errorMsg
    };
  }
}

async function createPowChallenge(authToken) {
  try {
    const headers = {
      'Host': 'chat.deepseek.com',
      'User-Agent': 'DeepSeek/1.0.13 Android/35',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/json',
      'x-client-platform': 'android',
      'x-client-version': '2.0.13',
      'x-client-locale': 'zh_CN',
      'accept-charset': 'UTF-8',
      'authorization': `Bearer ${authToken}`
    };

    const response = await axios.post(POW_CHALLENGE_URL, {
      target_path: '/api/v0/chat/completion'
    }, { headers });

    if (response.data?.data?.biz_data?.challenge) {
      return response.data.data.biz_data.challenge;
    }
    return null;
  } catch (error) {
    logger.error('POW Challenge Error:', error.message);
    return null;
  }
}

function computePowHash(challenge, salt, answer) {
  const data = challenge + salt + answer.toString();
  
  // 直接使用Node.js内置哈希
  return crypto.createHash('sha3-256').update(data).digest('hex');
}

async function solvePowChallenge(challengeData, salt, difficulty, targetPath) {
  logger.debug(`POW难度: ${difficulty}, 解决中...`);

  const startTime = Date.now();
  const challenge = typeof challengeData === 'string' ? challengeData : challengeData.challenge;
  
  // 计算目标阈值：difficulty决定需要多少个前导零
  // 难度144000意味着哈希值需要小于 2^256 / 144000
  let answer = 0;
  let hash = '';
  let found = false;
  
  // 计算目标值
  const maxHash = BigInt('0x' + 'f'.repeat(64)); // 2^256 - 1
  const target = maxHash / BigInt(difficulty);
  logger.debug(`目标阈值: ${target.toString(16).slice(0, 10)}...`);
  
  while (answer < 10000000) { // 最多尝试1000万次
    hash = computePowHash(challenge, salt, answer);
    
    // 检查哈希是否满足难度要求
    const hashNum = BigInt('0x' + hash);
    
    if (hashNum < target) {
      found = true;
      break;
    }
    
    answer++;
    
    if (answer % 100000 === 0) {
      logger.debug(`尝试 answer=${answer}, hash=${hash.slice(0, 20)}...`);
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info(`POW解决: answer=${answer}, 耗时=${elapsed}ms`);
  logger.debug(`是否找到有效哈希: ${found}, hash=${hash}`);

  const powResponse = Buffer.from(JSON.stringify({
    algorithm: 'DeepSeekHashV1',
    challenge: challenge, // 只使用challenge字符串
    salt: salt,
    answer: answer,
    signature: hash,
    target_path: targetPath
  })).toString('base64');

  return powResponse;
}

let activeType = null;
let reasoningContent = '';
let responseContent = '';

function extractContentFromSSE(sseData) {
  const lines = sseData.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const dataStr = line.slice(6).trim();
      if (dataStr === '' || dataStr === '[DONE]') continue;

      try {
        const data = JSON.parse(dataStr);
        handleOpObjForContent(data);
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
}

function handleOpObjForContent(obj) {
  if (!obj || typeof obj !== "object") return;
  
  // 格式1: {"v":"text"} - 纯文本增量
  if (obj.v && typeof obj.v === "string" && !obj.p) {
    if (activeType === 'THINK') {
      reasoningContent += obj.v;
    } else if (activeType === 'RESPONSE') {
      responseContent += obj.v;
    }
    return;
  }
  
  // 格式2: {"v":{"response":{"fragments":[...]}}}
  if (obj.v && typeof obj.v === "object" && !obj.p) {
    const resp = obj.v.response;
    if (resp && Array.isArray(resp.fragments)) {
      for (const frag of resp.fragments) {
        const fragType = frag?.type;
        if (fragType) activeType = fragType;
        if (typeof frag?.content === "string") {
          if (fragType === 'THINK') {
            reasoningContent += frag.content;
          } else {
            responseContent += frag.content;
          }
        }
      }
    }
    return;
  }
  
  const p = obj.p;
  const o = obj.o;
  const v = obj.v;
  
  // 格式3: {"p":"response","o":"BATCH","v":[...]}
  if (p === "response" && o === "BATCH" && Array.isArray(v)) {
    for (const item of v) {
      handleOpObjForContent(item);
    }
    return;
  }
  
  // 格式4: {"p":"fragments","o":"APPEND","v":[...]}
  if ((p === "fragments" || p === "response/fragments") && o === "APPEND" && Array.isArray(v)) {
    for (const frag of v) {
      const fragType = frag?.type;
      if (fragType) activeType = fragType;
      if (typeof frag?.content === "string") {
        if (fragType === 'THINK') {
          reasoningContent += frag.content;
        } else {
          responseContent += frag.content;
        }
      }
    }
    return;
  }
  
  // 格式5: {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
  if (p === "response/fragments/-1/content" && typeof v === "string") {
    if (!activeType) activeType = "RESPONSE";
    if (activeType === 'THINK') {
      reasoningContent += v;
    } else {
      responseContent += v;
    }
    return;
  }
}

function parseStreamTokens(obj) {
  const tokens = [];
  if (!obj || typeof obj !== "object") return tokens;
  
  // 格式1: {"v":"text"} - 纯文本增量
  if (obj.v && typeof obj.v === "string" && !obj.p) {
    if (activeType) {
      tokens.push({ content: obj.v, type: activeType });
    }
    return tokens;
  }
  
  // 格式2: {"v":{"response":{"fragments":[...]}}}
  if (obj.v && typeof obj.v === "object" && !obj.p) {
    const resp = obj.v.response;
    if (resp && Array.isArray(resp.fragments)) {
      for (const frag of resp.fragments) {
        const fragType = frag?.type;
        if (fragType) activeType = fragType;
        if (typeof frag?.content === "string") {
          tokens.push({ content: frag.content, type: fragType || activeType });
        }
      }
    }
    return tokens;
  }
  
  const p = obj.p;
  const o = obj.o;
  const v = obj.v;
  
  // 格式3: {"p":"response","o":"BATCH","v":[...]}
  if (p === "response" && o === "BATCH" && Array.isArray(v)) {
    for (const item of v) {
      tokens.push(...parseStreamTokens(item));
    }
    return tokens;
  }
  
  // 格式4: {"p":"fragments","o":"APPEND","v":[...]}
  if ((p === "fragments" || p === "response/fragments") && o === "APPEND" && Array.isArray(v)) {
    for (const frag of v) {
      const fragType = frag?.type;
      if (fragType) activeType = fragType;
      if (typeof frag?.content === "string") {
        tokens.push({ content: frag.content, type: fragType || activeType });
      }
    }
    return tokens;
  }
  
  // 格式5: {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
  if (p === "response/fragments/-1/content" && typeof v === "string") {
    if (!activeType) activeType = "RESPONSE";
    tokens.push({ content: v, type: activeType });
    return tokens;
  }
  
  return tokens;
}

async function makeDeepSeekRequest(requestBody, headers) {
  const response = await axios.post(DEEPSEEK_API_URL, requestBody, {
    headers,
    responseType: 'stream',
    timeout: 120000
  });

  activeType = null;
  reasoningContent = '';
  responseContent = '';
  const startTime = Date.now();
  let rawData = '';

  await new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      const chunkStr = chunk.toString();
      rawData += chunkStr;
      extractContentFromSSE(chunkStr);
    });

    response.data.on('end', resolve);
    response.data.on('error', reject);
  });

  return { reasoningContent, responseContent, startTime, rawData };
}

async function makeDeepSeekStreamRequest(requestBody, headers, res, model, includeReasoning) {
  const response = await axios.post(DEEPSEEK_API_URL, requestBody, {
    headers,
    responseType: 'stream',
    timeout: 120000
  });

  activeType = null;
  const startTime = Date.now();
  let firstChunk = true;
  let rawData = '';
  let headersSent = false;
  let hasContent = false;

  return new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      const chunkStr = chunk.toString();
      rawData += chunkStr;

      // 检测错误，但不发送响应
      if (rawData.includes('INVALID_POW_RESPONSE') || rawData.includes('"code":40301')) {
        resolve({ rawData, hasError: true, headersSent: false });
        return;
      }

      // 首次发送数据时设置响应头
      if (!headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        headersSent = true;
      }

      const lines = chunkStr.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (dataStr === '' || dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            const tokens = parseStreamTokens(data);
            
            // 检查是否有实际内容
            for (const token of tokens) {
              if (token.content && token.content.trim() !== '') {
                hasContent = true;
              }
            }

            for (const token of tokens) {
              const isReasoning = token.type === 'THINK';
              const delta = firstChunk 
                ? { role: 'assistant', content: token.content }
                : { content: token.content };
              
              if (includeReasoning && isReasoning) {
                delta.reasoning_content = token.content;
                delta.content = '';
              }
              
              const chunkData = {
                id: `chatcmpl-${generateUUID()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(startTime / 1000),
                model: model || 'deepseek-chat',
                choices: [{
                  index: 0,
                  delta: delta,
                  finish_reason: null
                }]
              };
              firstChunk = false;
              res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    });

    response.data.on('end', () => {
      if (headersSent) {
        const finishData = {
          id: `chatcmpl-${generateUUID()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(startTime / 1000),
          model: model || 'deepseek-chat',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        res.write(`data: ${JSON.stringify(finishData)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        resolve({ rawData, hasError: false, headersSent });
      } else if (!hasContent) {
        // 如果没有发送任何内容，标记为有错误
        resolve({ rawData, hasError: true, headersSent: false });
      } else {
        resolve({ rawData, hasError: false, headersSent });
      }
    });

    response.data.on('error', (err) => {
      if (headersSent) {
        res.end();
      }
      reject(err);
    });
  });
}

function getAuthByEmail(email) {
  return authCache.find(a => a.email === email);
}

function updateAuthCache(authData) {
  const index = authCache.findIndex(a => a.email === authData.email);
  if (index >= 0) {
    authCache[index] = { ...authCache[index], ...authData };
  } else {
    authCache.push(authData);
  }
  saveAuthCache();
}

function getAvailableAccounts() {
  // 获取可用账号（排除失败的账号）
  const available = accounts.filter(acc => {
    const cached = getAuthByEmail(acc.email);
    // 排除已标记为失败的账号
    // 如果没有缓存，或者缓存中 failed 不是 true，则认为可用
    const isAvailable = !cached || cached.failed !== true;
    if (!isAvailable) {
      logger.debug(`账号 ${maskEmail(acc.email)} 已被排除 (failed: ${cached?.failed})`);
    }
    return isAvailable;
  });
  logger.debug(`可用账号数量: ${available.length}/${accounts.length}`);
  return available;
}

function getAccountStats() {
  const total = accounts.length;
  const successCount = accounts.filter(acc => {
    const cached = getAuthByEmail(acc.email);
    return cached?.authorization && !cached?.failed;
  }).length;
  return { total, successCount };
}

function getAccountIndex(email) {
  return accounts.findIndex(a => a.email === email);
}

async function ensureAuth(email = null) {
  // 没有配置账号时返回错误信息
  if (accounts.length === 0) {
    logger.warn('没有配置账号');
    return { authData: null, error: '未配置 DeepSeek 账号，请设置环境变量 DEEPSEEK_ACCOUNTS' };
  }

  // 如果指定了邮箱，使用指定账号
  if (email) {
    const account = accounts.find(a => a.email === email);
    if (account) {
      const cached = getAuthByEmail(email);
      if (cached?.authorization && cached.failed !== true) {
        logger.debug(`使用指定账号缓存认证: ${maskEmail(email)}`);
        return { authData: cached, error: null };
      }
      // 需要重新登录
      return await loginAndCache(account);
    }
  }

  // 获取所有已有有效 authorization 的账号
  const validCachedAccounts = accounts.filter(acc => {
    const cached = getAuthByEmail(acc.email);
    const isValid = cached?.authorization && cached.failed !== true;
    logger.debug(`账号 ${maskEmail(acc.email)}: authorization=${!!cached?.authorization}, failed=${cached?.failed}, isValid=${isValid}`);
    return isValid;
  });

  logger.debug(`有效缓存账号数量: ${validCachedAccounts.length}`);

  // 如果有有效缓存的账号，随机选择一个
  if (validCachedAccounts.length > 0) {
    const randomAccount = validCachedAccounts[Math.floor(Math.random() * validCachedAccounts.length)];
    const cached = getAuthByEmail(randomAccount.email);
    logger.info(`随机使用缓存认证: ${maskEmail(cached.email)}`);
    return { authData: cached, error: null };
  }

  // 没有有效缓存，从可用账号中随机选择并登录
  const availableAccounts = getAvailableAccounts();
  if (availableAccounts.length === 0) {
    // 所有账号都已失效，收集错误信息
    const failedAccounts = authCache.filter(a => a.failed);
    const errorDetails = failedAccounts.map(a => `${maskEmail(a.email)}: ${a.error}`).join('; ');
    logger.warn('所有账号都已失效，请检查账号配置');
    return { 
      authData: null, 
      error: `所有 DeepSeek 账号都已失效 (${errorDetails})` 
    };
  }
  
  const account = availableAccounts[Math.floor(Math.random() * availableAccounts.length)];
  logger.info(`选择账号尝试登录: ${maskEmail(account.email)}`);
  return await loginAndCache(account);
}

async function loginAndCache(account) {
  logger.info(`使用账号: ${maskEmail(account.email)}`);

  const result = await login(account.email, account.password);
  
  if (result.success) {
    const authData = {
      email: account.email,
      authorization: result.authorization,
      device_id: result.device_id,
      timestamp: Date.now(),
      failed: false,
      error: null,
      failure_type: null
    };
    updateAuthCache(authData);
    logger.info(`账号 ${maskEmail(account.email)} 登录成功!`);
    return { authData, error: null };
  } else {
    // 保存失败状态
    const authData = {
      email: account.email,
      authorization: null,
      device_id: null,
      timestamp: Date.now(),
      failed: true,
      error: result.error,
      failure_type: 'login_failed'
    };
    updateAuthCache(authData);
    logger.warn(`账号 ${maskEmail(account.email)} 登录失败: ${result.error}`);
    
    // 尝试其他可用账号
    const otherAvailable = getAvailableAccounts();
    if (otherAvailable.length > 0) {
      logger.info(`尝试使用其他账号...`);
      return ensureAuth();
    }
    
    return { 
      authData: null, 
      error: `账号 ${account.email} 登录失败: ${result.error}` 
    };
  }
}

async function createChatSession(authorization, email) {
  try {
    logger.debug(`创建会话请求... (账号: ${maskEmail(email)})`);
    const response = await axios({
      method: 'POST',
      url: 'https://chat.deepseek.com/api/v0/chat_session/create',
      headers: {
        'Host': 'chat.deepseek.com',
        'User-Agent': 'DeepSeek/1.0.13 Android/35',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
        'x-client-platform': 'android',
        'x-client-version': '2.0.13',
        'x-client-locale': 'zh_CN',
        'accept-charset': 'UTF-8',
        'authorization': `Bearer ${authorization}`
      },
      data: { agent: 'chat' },
      timeout: 30000
    });

    logger.debug('创建会话响应:', JSON.stringify(response.data, null, 2));
    
    // 尝试两种响应格式：Android客户端格式和Web客户端格式
    let sessionId = null;
    if (response.data?.code === 0) {
      // Android客户端格式: biz_data.chat_session.id
      sessionId = response.data?.data?.biz_data?.chat_session?.id;
      // Web客户端格式: biz_data.id
      if (!sessionId) {
        sessionId = response.data?.data?.biz_data?.id;
      }
    }
    
    if (sessionId) {
      logger.info(`会话创建成功: ${sessionId} (账号: ${maskEmail(email)})`);
      return sessionId;
    }
    logger.warn(`会话创建失败: 响应格式不正确 (账号: ${maskEmail(email)})`);
    return null;
  } catch (error) {
    logger.error(`创建会话失败 (账号: ${maskEmail(email)}):`, error.message);
    if (error.response) {
      logger.debug('响应数据:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

async function refreshAuthWithPow(authData) {
  if (!authData?.authorization) {
    return null;
  }

  logger.debug('创建POW挑战...');
  const challenge = await createPowChallenge(authData.authorization);

  if (!challenge) {
    logger.warn('POW挑战创建失败');
    return null;
  }

  logger.debug('开始解决POW...');
  logger.debug('Challenge:', JSON.stringify(challenge));
  
  // 使用正确的WASM POW实现
  const powResponse = await getPowResponse(challenge);

  if (powResponse) {
    // Debug: decode and log the generated POW
    const decodedPow = JSON.parse(Buffer.from(powResponse, 'base64').toString());
    logger.debug('生成的POW:', JSON.stringify(decodedPow));
    logger.debug(`签名匹配: ${decodedPow.signature === challenge.signature}`);
    authData['x-ds-pow-response'] = powResponse;
    authData.timestamp = Date.now();
    updateAuthCache(authData);
    logger.debug('POW已刷新');
    return authData;
  }

  return null;
}

async function getPowChallengeAndSolve(authorization) {
  const challenge = await createPowChallenge(authorization);

  if (!challenge) {
    logger.warn('POW挑战创建失败');
    return null;
  }

  logger.debug('Challenge:', JSON.stringify(challenge));
  
  const powResponse = await getPowResponse(challenge);

  if (powResponse) {
    logger.debug('POW获取成功');
    return powResponse;
  }

  return null;
}

app.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  const { messages, model, stream, temperature, max_tokens, reasoning_effort, thinking, web_search_options, tools, ...extraParams } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Missing messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'missing_messages'
      }
    });
  }

  // 解析思考模式参数
  // thinking 参数格式: {"type": "enabled"} 或 {"type": "disabled"}
  // reasoning_effort 参数: low/medium/high/max
  let thinkingEnabled = extraParams.thinking_enabled || false;
  
  // 支持 thinking.type 参数
  if (thinking && typeof thinking === 'object') {
    thinkingEnabled = thinking.type === 'enabled';
  }
  
  // 支持 reasoning_effort 参数（如果有设置，则启用思考模式）
  if (reasoning_effort) {
    thinkingEnabled = true;
  }
  
  const includeReasoning = thinkingEnabled;

  // 解析搜索模式参数
  // web_search_options: OpenAI Chat Completions API 的搜索选项
  // tools: [{"type": "web_search"}] - OpenAI Responses API 的搜索工具
  let searchEnabled = extraParams.search_enabled !== false;
  
  // 支持 web_search_options 参数
  if (web_search_options !== undefined) {
    searchEnabled = true;
  }
  
  // 支持 tools 中的 web_search 类型
  if (tools && Array.isArray(tools)) {
    const hasWebSearch = tools.some(tool => 
      tool && (tool.type === 'web_search' || tool.type === 'web_search_preview')
    );
    if (hasWebSearch) {
      searchEnabled = true;
    }
  }

  // 获取 model_type（从 model 参数解析）
  const modelType = getModelTypeFromRequest(model);
  // 获取显示用的 model id
  const displayModelId = getModelId(modelType);

  // 获取认证
  const { authData, error } = await ensureAuth();
  if (!authData?.authorization) {
    return res.status(401).json({
      error: {
        message: error || 'Authentication failed',
        type: 'authentication_error',
        code: 'auth_failed'
      }
    });
  }

  // 设置账号信息响应头
    const stats = getAccountStats();
    const accountIndex = getAccountIndex(authData.email);
    res.setHeader('X-Account-Total', stats.total);
    res.setHeader('X-Account-Success', stats.successCount);
    res.setHeader('X-Account-Index', accountIndex >= 0 ? accountIndex : -1);
    res.setHeader('X-Account-Id', maskEmail(authData.email));

  // 创建新的聊天会话
  const chatSessionId = await createChatSession(authData.authorization, authData.email);
  if (!chatSessionId) {
    return res.status(500).json({
      error: {
        message: 'Failed to create chat session',
        type: 'server_error',
        code: 'session_creation_failed'
      }
    });
  }
  logger.debug(`创建新会话: ${chatSessionId}`);

  // 使用 messagesPrepare 格式化所有消息（支持多轮对话）
  const prompt = messagesPrepare(messages);

  // 构建请求体
  const requestBody = {
    chat_session_id: chatSessionId,
    parent_message_id: null,
    model_type: modelType,
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: thinkingEnabled,
    search_enabled: searchEnabled,
    preempt: false,
    temperature: temperature || 0.6,
    max_tokens: max_tokens || 1024,
    top_p: extraParams.top_p || 1.0,
    presence_penalty: extraParams.presence_penalty || 0,
    frequency_penalty: extraParams.frequency_penalty || 0,
    stop: extraParams.stop || null
  };

  logger.debug('DeepSeek请求参数:', JSON.stringify(requestBody, null, 2));

  // 每次请求都重新获取 POW
  logger.debug('获取POW...');
  const powResponse = await getPowChallengeAndSolve(authData.authorization);

  // 使用Android客户端请求头
  const headers = {
    'Host': 'chat.deepseek.com',
    'User-Agent': 'DeepSeek/1.0.13 Android/35',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json',
    'x-client-platform': 'android',
    'x-client-version': '2.0.13',
    'x-client-locale': 'zh_CN',
    'accept-charset': 'UTF-8',
    'authorization': `Bearer ${authData.authorization}`,
    'x-ds-pow-response': powResponse || ''
  };

  try {
    // 流式请求使用专门的流式处理函数
    if (stream) {
      // 创建一个包装函数，用于记录响应内容
      let streamContent = '';
      let streamReasoningContent = '';
      const originalMakeDeepSeekStreamRequest = makeDeepSeekStreamRequest;
      
      // 重写 makeDeepSeekStreamRequest 以捕获内容，但这里我们用另一种方式
      // 我们先正常发送请求，然后在响应结束后检查
      const result = await makeDeepSeekStreamRequest(requestBody, headers, res, displayModelId, includeReasoning);
      
      // 如果有错误但尚未发送响应头
      if (result.hasError && !result.headersSent) {
        // 检查是否是内容为空导致的，可能是账号被封
        if (result.rawData && !result.rawData.includes('INVALID_POW_RESPONSE') && !result.rawData.includes('error')) {
          // 检查账号是否被封
          logger.warn(`流式请求响应异常，检查账号 ${maskEmail(authData.email)} 是否被封...`);
          const bannedCheck = await checkAccountBanned(authData.authorization, authData.email);
          if (bannedCheck.banned) {
            // 标记账号为失败
            const authDataToUpdate = getAuthByEmail(authData.email);
            if (authDataToUpdate) {
              authDataToUpdate.failed = true;
              authDataToUpdate.error = '账号已被封禁';
              authDataToUpdate.failure_type = 'banned';
              authDataToUpdate.mute_until = bannedCheck.muteUntil;
              updateAuthCache(authDataToUpdate);
            }
            
            // 尝试其他账号重试
            logger.warn(`账号 ${maskEmail(authData.email)} 已被封禁，尝试使用其他账号重试流式请求...`);
            const { authData: newAuthData, error: newError } = await ensureAuth();
            if (newAuthData?.authorization && newAuthData.email !== authData.email) {
              // 创建新会话
              const newChatSessionId = await createChatSession(newAuthData.authorization, newAuthData.email);
              if (newChatSessionId) {
                // 更新请求体
                requestBody.chat_session_id = newChatSessionId;
                
                // 获取新的POW
                const newPowResponse = await getPowChallengeAndSolve(newAuthData.authorization);
                
                // 更新请求头
                const newHeaders = {
                  ...headers,
                  'authorization': `Bearer ${newAuthData.authorization}`,
                  'x-ds-pow-response': newPowResponse || ''
                };
                
                // 更新响应头
            const newStats = getAccountStats();
            const newAccountIndex = getAccountIndex(newAuthData.email);
            res.setHeader('X-Account-Total', newStats.total);
            res.setHeader('X-Account-Success', newStats.successCount);
            res.setHeader('X-Account-Index', newAccountIndex >= 0 ? newAccountIndex : -1);
            res.setHeader('X-Account-Id', maskEmail(newAuthData.email));
                
                // 重试
                const retryResult = await makeDeepSeekStreamRequest(requestBody, newHeaders, res, displayModelId, includeReasoning);
                if (!retryResult.hasError || retryResult.headersSent) {
                  return;
                }
              }
            }
          }
        }
        
        // POW错误，重新获取 POW 重试
        logger.warn('流式请求POW无效，重新获取...');
        const newPowResponse = await getPowChallengeAndSolve(authData.authorization);
        if (newPowResponse) {
          headers['x-ds-pow-response'] = newPowResponse;
          const retryResult = await makeDeepSeekStreamRequest(requestBody, headers, res, displayModelId, includeReasoning);
          if (retryResult.hasError && !retryResult.headersSent) {
            // 重试失败，返回错误
            res.writeHead(400, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*'
            });
            res.write(`data: ${JSON.stringify({ error: { message: 'POW验证失败' } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }
      }
      return;
    }

    // 非流式请求
    let { reasoningContent: rc, responseContent: cc, startTime, rawData } = await makeDeepSeekRequest(requestBody, headers);
    logger.debug('DeepSeek原始响应:', rawData.slice(0, 300));
    logger.debug('思考内容:', rc);
    logger.debug('回答内容:', cc);

    if (rawData?.includes('INVALID_POW_RESPONSE')) {
      logger.warn('POW无效，重新获取...');
      const newPowResponse = await getPowChallengeAndSolve(authData.authorization);
      if (newPowResponse) {
        headers['x-ds-pow-response'] = newPowResponse;
        try {
          const retry = await makeDeepSeekRequest(requestBody, headers);
          logger.debug('重试响应:', retry.rawData.slice(0, 300));
          if (!retry.rawData?.includes('INVALID_POW_RESPONSE')) {
            rc = retry.reasoningContent;
            cc = retry.responseContent;
            rawData = retry.rawData;
          } else {
            logger.warn('重试后POW仍然无效');
          }
        } catch (retryError) {
          logger.error('重试请求失败:', retryError.message);
        }
      }
    }

    const fullContent = cc || rc;
    if (rawData?.includes('INVALID_POW_RESPONSE') || rawData?.includes('error') || fullContent === '') {
      // 如果内容为空，检查账号是否被封
    if (fullContent === '' && !rawData?.includes('INVALID_POW_RESPONSE') && !rawData?.includes('error')) {
      logger.warn(`API返回内容为空，检查账号 ${maskEmail(authData.email)} 是否被封...`);
      const bannedCheck = await checkAccountBanned(authData.authorization, authData.email);
      if (bannedCheck.banned) {
        // 标记账号为失败
        const authDataToUpdate = getAuthByEmail(authData.email);
        if (authDataToUpdate) {
          authDataToUpdate.failed = true;
          authDataToUpdate.error = '账号已被封禁';
          authDataToUpdate.failure_type = 'banned';
          authDataToUpdate.mute_until = bannedCheck.muteUntil;
          updateAuthCache(authDataToUpdate);
        }
        
        // 尝试其他可用账号重试
        logger.warn(`账号 ${maskEmail(authData.email)} 已被封禁，尝试使用其他账号重试...`);
          const { authData: newAuthData, error: newError } = await ensureAuth();
          if (newAuthData?.authorization && newAuthData.email !== authData.email) {
            // 创建新会话
            const newChatSessionId = await createChatSession(newAuthData.authorization, newAuthData.email);
            if (newChatSessionId) {
              // 更新请求体中的会话ID
              requestBody.chat_session_id = newChatSessionId;
              
              // 获取新的POW
              const newPowResponse = await getPowChallengeAndSolve(newAuthData.authorization);
              
              // 更新请求头
              const newHeaders = {
                ...headers,
                'authorization': `Bearer ${newAuthData.authorization}`,
                'x-ds-pow-response': newPowResponse || ''
              };
              
              // 更新响应头中的账号信息
            const newStats = getAccountStats();
            const newAccountIndex = getAccountIndex(newAuthData.email);
            res.setHeader('X-Account-Total', newStats.total);
            res.setHeader('X-Account-Success', newStats.successCount);
            res.setHeader('X-Account-Index', newAccountIndex >= 0 ? newAccountIndex : -1);
            res.setHeader('X-Account-Id', maskEmail(newAuthData.email));
              
              // 重新发送请求
              const retry = await makeDeepSeekRequest(requestBody, newHeaders);
              const newFullContent = retry.responseContent || retry.reasoningContent;
              if (newFullContent) {
                const newMessage = { role: 'assistant', content: retry.responseContent || '' };
                if (includeReasoning && retry.reasoningContent) {
                  newMessage.reasoning_content = retry.reasoningContent;
                }
                
                const openAIResponse = {
                  id: `chatcmpl-${generateUUID()}`,
                  object: 'chat.completion',
                  created: Math.floor(retry.startTime / 1000),
                  model: displayModelId,
                  choices: [{
                    index: 0,
                    message: newMessage,
                    finish_reason: 'stop'
                  }],
                  usage: {
                    prompt_tokens: Math.ceil(prompt.length / 4),
                    completion_tokens: Math.ceil(newFullContent.length / 4),
                    total_tokens: Math.ceil(prompt.length / 4) + Math.ceil(newFullContent.length / 4)
                  }
                };
                return res.json(openAIResponse);
              }
            }
          }
        }
      }
      
      logger.warn('API返回错误或内容为空，返回错误信息');
      const errorMessage = rawData?.includes('INVALID_POW_RESPONSE') ? 'POW验证失败' : 'DeepSeek API返回错误';
      res.status(400).json({
        error: { message: errorMessage, type: 'invalid_request_error', param: null, code: 'api_error' }
      });
      return;
    }

    const message = { role: 'assistant', content: cc || '' };
    if (includeReasoning && rc) {
      message.reasoning_content = rc;
    }

    const openAIResponse = {
      id: `chatcmpl-${generateUUID()}`,
      object: 'chat.completion',
      created: Math.floor(startTime / 1000),
      model: displayModelId,
      choices: [{
        index: 0,
        message: message,
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(fullContent.length / 4),
        total_tokens: Math.ceil(prompt.length / 4) + Math.ceil(fullContent.length / 4)
      }
    };
    res.json(openAIResponse);
  } catch (error) {
    let errorMessage = error.message || 'Internal server error';
    let statusCode = 500;
    let errorCode = 'server_error';
    let errorType = 'server_error';

    if (typeof error.response?.data === 'string' && error.response.data.includes('INVALID_POW_RESPONSE')) {
      errorMessage = 'POW验证失败';
      errorType = 'invalid_request_error';
      errorCode = 'invalid_pow_response';
      statusCode = 400;
    } else if (errorMessage.includes('Rate Limit')) {
      errorMessage = 'Rate limit reached.';
      errorType = 'rate_limit_error';
      errorCode = 'rate_limit_exceeded';
      statusCode = 429;
    }

    res.status(statusCode).json({
      error: { message: errorMessage, type: errorType, param: null, code: errorCode }
    });
  }
});

app.get('/v1/models', authenticateApiKey, (req, res) => {
  const models = [];
  
  for (const type of modelTypes) {
    const mapping = modelMapping[type];
    if (!mapping) {
      // 没有映射，直接使用 type 作为 id
      models.push({
        id: type,
        object: 'model',
        created: 1677610602,
        owned_by: 'deepseek',
        description: `DeepSeek ${type} model`
      });
    } else if (Array.isArray(mapping)) {
      // 数组格式，显示所有映射
      for (const id of mapping) {
        models.push({
          id: id,
          object: 'model',
          created: 1677610602,
          owned_by: 'deepseek',
          description: `DeepSeek ${type} model`
        });
      }
    } else if (typeof mapping === 'string' && mapping.includes(',')) {
      // 逗号分隔格式，显示所有映射
      const ids = mapping.split(',').map(id => id.trim());
      for (const id of ids) {
        models.push({
          id: id,
          object: 'model',
          created: 1677610602,
          owned_by: 'deepseek',
          description: `DeepSeek ${type} model`
        });
      }
    } else {
      // 单个映射
      models.push({
        id: mapping,
        object: 'model',
        created: 1677610602,
        owned_by: 'deepseek',
        description: `DeepSeek ${type} model`
      });
    }
  }
  
  res.json({
    object: 'list',
    data: models
  });
});

app.get('/health', (req, res) => {
  const validAuths = authCache.filter(a => a.authorization && !a.failed);
  const failedAuths = authCache.filter(a => a.failed);
  
  const loginFailedAccounts = failedAuths.filter(a => a.failure_type === 'login_failed');
  const bannedAccounts = failedAuths.filter(a => a.failure_type === 'banned');
  
  const accountDetails = accounts.map(acc => {
    const cached = getAuthByEmail(acc.email);
    return {
      email: maskEmail(acc.email),
      status: !cached ? 'unknown' : 
              !cached.failed ? 'available' : 
              cached.failure_type === 'banned' ? 'banned' : 'login_failed',
      mute_until: cached?.mute_until || null,
      error: cached?.error || null
    };
  });
  
  res.json({
    status: 'ok',
    accounts: {
      total: accounts.length,
      available: validAuths.length,
      login_failed: loginFailedAccounts.length,
      banned: bannedAccounts.length,
      details: accountDetails
    }
  });
});

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') {
    return email;
  }
  
  const atIndex = email.indexOf('@');
  if (atIndex === -1) {
    // 不是email格式，原样返回
    return email;
  }
  
  let localPart = email.substring(0, atIndex);
  const domainPart = email.substring(atIndex + 1); // 去掉@符号
  
  // 处理本地部分
  let maskedLocal;
  if (localPart.length <= 2) {
    // 本地部分太短，只显示第一个字符
    maskedLocal = localPart.charAt(0) + '***';
  } else {
    // 显示前2个字符，中间用***
    maskedLocal = localPart.substring(0, 2) + '***';
  }
  
  // 处理域名部分
  let maskedDomain;
  const dotIndex = domainPart.indexOf('.');
  if (dotIndex === -1) {
    // 没有点，只显示第一个字符
    maskedDomain = domainPart.charAt(0) + '***';
  } else {
    const domainName = domainPart.substring(0, dotIndex);
    const tld = domainPart.substring(dotIndex);
    
    if (domainName.length <= 2) {
      // 域名太短，只显示第一个字符
      maskedDomain = domainName.charAt(0) + '***' + tld;
    } else {
      // 显示前2个字符，中间用***
      maskedDomain = domainName.substring(0, 2) + '***' + tld;
    }
  }
  
  return maskedLocal + '@' + maskedDomain;
}

async function checkUnbanAccounts() {
  logger.info('开始检查账号解封状态...');
  
  for (const acc of accounts) {
    const cached = getAuthByEmail(acc.email);
    if (!cached?.failed || !cached?.mute_until) {
      continue;
    }

    // 检查是否过了解封时间
    const now = Date.now();
    const muteUntilMs = cached.mute_until * 1000; // 假设是Unix时间戳，秒转毫秒
    
    if (now > muteUntilMs) {
      logger.info(`账号 ${maskEmail(acc.email)} 可能已解封，尝试重新验证...`);
      
      // 尝试重新登录
      const result = await login(acc.email, acc.password);
      
      if (result.success) {
        // 登录成功，更新状态
        const authData = {
          email: acc.email,
          authorization: result.authorization,
          device_id: result.device_id,
          timestamp: Date.now(),
          failed: false,
          error: null,
          failure_type: null,
          mute_until: null
        };
        updateAuthCache(authData);
        logger.info(`账号 ${maskEmail(acc.email)} 已成功解封并重新登录！`);
      } else {
        logger.warn(`账号 ${maskEmail(acc.email)} 尝试重新登录失败: ${result.error}`);
        // 保留失败状态
        const authData = {
          ...cached,
          timestamp: Date.now()
        };
        updateAuthCache(authData);
      }
    } else {
      // 还没到解封时间
      const remaining = Math.ceil((muteUntilMs - now) / 1000 / 60 / 60);
      logger.info(`账号 ${maskEmail(acc.email)} 还需 ${remaining} 小时解封`);
    }
  }
  
  logger.info('账号解封检查完成');
}

function startUnbanCheckTimer() {
  // 立即执行一次
  checkUnbanAccounts();
  
  // 每小时检查一次
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(() => {
    checkUnbanAccounts();
  }, ONE_HOUR);
  
  logger.info('定时任务已启动：每小时检查一次账号解封状态');
}

async function startServer() {
  loadModelConfig();
  loadApiKeys();
  await loadAccounts();
  
  // 清除旧的认证缓存，重新验证所有账号
  if (fs.existsSync(CACHE_FILE)) {
    fs.unlinkSync(CACHE_FILE);
    logger.info('已清除旧的认证缓存');
  }
  authCache = [];

  // 加载WASM模块
  await loadWasmModule();

  if (accounts.length === 0) {
    logger.warn('未配置账号，请设置环境变量 DEEPSEEK_ACCOUNTS');
    logger.warn('服务将启动，但请求会返回认证错误');
  } else {
    logger.info(`配置了 ${accounts.length} 个账号，正在验证...`);

    // 尝试登录所有账号，更新状态
    for (const acc of accounts) {
      const cached = getAuthByEmail(acc.email);
      // 如果缓存中没有有效认证，尝试登录
      if (!cached?.authorization || cached?.failed) {
        logger.info(`验证账号: ${maskEmail(acc.email)}`);
        const result = await login(acc.email, acc.password);
        
        if (result.success) {
          const authData = {
            email: acc.email,
            authorization: result.authorization,
            device_id: result.device_id,
            timestamp: Date.now(),
            failed: false,
            error: null,
            failure_type: null
          };
          updateAuthCache(authData);
          logger.info(`账号 ${maskEmail(acc.email)} 验证成功!`);
        } else {
          const authData = {
            email: acc.email,
            authorization: null,
            device_id: null,
            timestamp: Date.now(),
            failed: true,
            error: result.error,
            failure_type: 'login_failed'
          };
          updateAuthCache(authData);
          logger.warn(`账号 ${maskEmail(acc.email)} 验证失败: ${result.error}`);
        }
      } else if (cached?.authorization) {
        // 已有有效认证，检查是否被封
        logger.info(`检查账号 ${maskEmail(acc.email)} 是否被封...`);
        const bannedCheck = await checkAccountBanned(cached.authorization, acc.email);
        if (bannedCheck.banned) {
          const authData = {
            email: acc.email,
            authorization: cached.authorization,
            device_id: cached.device_id,
            timestamp: Date.now(),
            failed: true,
            error: '账号已被封禁',
            failure_type: 'banned',
            mute_until: bannedCheck.muteUntil
          };
          updateAuthCache(authData);
          logger.warn(`账号 ${maskEmail(acc.email)} 已被封禁，标记为失败`);
        }
      }
    }

    // 显示所有账号状态
    logger.info('账号状态:');
    let successCount = 0;
    accounts.forEach((a, i) => {
      const cached = getAuthByEmail(a.email);
      if (cached?.failed) {
        logger.info(`  ${i + 1}. ${maskEmail(a.email)} - ❌ 失败: ${cached.error}`);
      } else if (cached?.authorization) {
        logger.info(`  ${i + 1}. ${maskEmail(a.email)} - ✓ 正常`);
        successCount++;
      } else {
        logger.info(`  ${i + 1}. ${maskEmail(a.email)} - ? 未验证`);
      }
    });

    if (successCount === 0) {
      logger.warn('所有账号认证失败，请求时将尝试重新认证');
    } else {
      logger.info(`共 ${successCount}/${accounts.length} 个账号可用`);
    }
  }

  app.listen(PORT, () => {
    logger.info(`DeepSeek to OpenAI API server running on port ${PORT}`);
    logger.info(`Chat: http://localhost:${PORT}/v1/chat/completions`);
    logger.info(`Models: http://localhost:${PORT}/v1/models`);
    logger.info(`Health: http://localhost:${PORT}/health`);
    
    // 启动定时任务检查账号解封
    startUnbanCheckTimer();
  });
}

startServer();
