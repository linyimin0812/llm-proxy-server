const http = require('http');
const https = require('https');
const { URL } = require('url');

// ═══════════════════════════════════════════════════════════════
//  配置区域
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // 代理服务器监听端口
  PORT: process.env.PORT || 3003,
  
  // 目标API地址（支持环境变量覆盖）
  TARGET_URL: process.env.TARGET_URL || 'https://us.vveai.com',
  
  // 是否打印完整的请求头
  LOG_HEADERS: process.env.LOG_HEADERS !== 'false',
  
  // 是否美化JSON输出
  PRETTY_JSON: process.env.PRETTY_JSON !== 'false',
};

// ═══════════════════════════════════════════════════════════════
//  颜色工具（兼容无chalk环境）
// ═══════════════════════════════════════════════════════════════

let chalk;
try {
  chalk = require('chalk');
} catch {
  // 如果没有chalk，使用简单的fallback
  chalk = {
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    gray: (s) => `\x1b[90m${s}\x1b[0m`,
    magenta: (s) => `\x1b[35m${s}\x1b[0m`,
    bold: { cyan: (s) => `\x1b[1m\x1b[36m${s}\x1b[0m` },
    bgBlue: { white: (s) => `\x1b[44m\x1b[37m${s}\x1b[0m` },
    bgGreen: { black: (s) => `\x1b[42m\x1b[30m${s}\x1b[0m` },
    bgYellow: { black: (s) => `\x1b[43m\x1b[30m${s}\x1b[0m` },
    bgRed: { white: (s) => `\x1b[41m\x1b[37m${s}\x1b[0m` },
  };
}

// ═══════════════════════════════════════════════════════════════
//  日志工具
// ═══════════════════════════════════════════════════════════════

const divider = '─'.repeat(70);
const doubleDivider = '═'.repeat(70);

function timestamp() {
  return new Date().toISOString();
}

function formatJson(data) {
  if (!data) return '';
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return CONFIG.PRETTY_JSON 
      ? JSON.stringify(parsed, null, 2) 
      : JSON.stringify(parsed);
  } catch {
    return data;
  }
}

function logRequest(reqId, method, path, headers, body) {
  console.log('\n' + chalk.bgBlue.white(` ▶ REQUEST [${reqId}] `) + ' ' + chalk.gray(timestamp()));
  console.log(chalk.cyan(doubleDivider));
  console.log(chalk.yellow(`${method} ${path}`));
  
  if (CONFIG.LOG_HEADERS) {
    console.log(chalk.gray(divider));
    console.log(chalk.magenta('Headers:'));
    const safeHeaders = { ...headers };
    // 隐藏敏感信息
    if (safeHeaders.authorization) {
      safeHeaders.authorization = safeHeaders.authorization.substring(0, 20) + '...';
    }
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = safeHeaders['x-api-key'].substring(0, 10) + '...';
    }
    console.log(chalk.gray(formatJson(safeHeaders)));
  }
  
  if (body) {
    console.log(chalk.gray(divider));
    console.log(chalk.magenta('Body:'));
    console.log(chalk.green(formatJson(body)));
  }
  console.log(chalk.cyan(doubleDivider) + '\n');
}

function logResponseStart(reqId, statusCode) {
  console.log('\n' + chalk.bgGreen.black(` ◀ RESPONSE [${reqId}] `) + ' ' + chalk.gray(timestamp()));
  console.log(chalk.green(doubleDivider));
  
  const statusColor = statusCode >= 400 ? chalk.red : chalk.green;
  console.log(statusColor(`Status: ${statusCode}`));
  console.log(chalk.gray(divider));
}

function logResponseBody(content, isStream = false) {
  if (isStream) {
    console.log(chalk.magenta('Stream Data:'));
  } else {
    console.log(chalk.magenta('Body:'));
  }
  console.log(chalk.cyan(formatJson(content)));
}

function logResponseEnd() {
  console.log(chalk.green(doubleDivider) + '\n');
}

function logStreamChunk(chunk) {
  // 解析SSE格式
  const lines = chunk.toString().split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') {
        console.log(chalk.yellow('  [STREAM END]'));
      } else {
        try {
          const parsed = JSON.parse(data);
          // 提取关键内容
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            process.stdout.write(chalk.cyan(delta.content));
          } else if (delta?.role) {
            console.log(chalk.gray(`  [Role: ${delta.role}]`));
          }
        } catch {
          // 非JSON格式，直接输出
          if (data.trim()) {
            console.log(chalk.gray(`  ${data}`));
          }
        }
      }
    }
  }
}

function logError(reqId, error) {
  console.log('\n' + chalk.bgRed.white(` ✖ ERROR [${reqId}] `) + ' ' + chalk.gray(timestamp()));
  console.log(chalk.red(doubleDivider));
  console.log(chalk.red(error.message || error));
  console.log(chalk.red(doubleDivider) + '\n');
}

// ═══════════════════════════════════════════════════════════════
//  代理服务器
// ═══════════════════════════════════════════════════════════════

let requestCounter = 0;

function createProxyServer() {
  const targetUrl = new URL(CONFIG.TARGET_URL);
  const isHttps = targetUrl.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const server = http.createServer((clientReq, clientRes) => {
    const reqId = ++requestCounter;
    let requestBody = '';

    // 收集请求体
    clientReq.on('data', (chunk) => {
      requestBody += chunk.toString();
    });

    clientReq.on('end', () => {
      // 打印请求日志
      logRequest(reqId, clientReq.method, clientReq.url, clientReq.headers, requestBody);

      // 构建代理请求选项
      const proxyHeaders = { ...clientReq.headers, host: targetUrl.host };
      // 移除压缩相关头，确保响应为纯文本便于日志打印
      delete proxyHeaders['accept-encoding'];
      
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: clientReq.url,
        method: clientReq.method,
        headers: proxyHeaders,
      };

      // 发送代理请求
      const proxyReq = httpModule.request(options, (proxyRes) => {
        const isStreamResponse = proxyRes.headers['content-type']?.includes('text/event-stream');
        
        logResponseStart(reqId, proxyRes.statusCode);
        
        // 设置响应头
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

        if (isStreamResponse) {
          console.log(chalk.yellow('  [Streaming Response]'));
          // 处理流式响应
          proxyRes.on('data', (chunk) => {
            logStreamChunk(chunk);
            clientRes.write(chunk);
          });

          proxyRes.on('end', () => {
            console.log(''); // 换行
            logResponseEnd();
            clientRes.end();
          });
        } else {
          // 处理普通响应
          let responseBody = '';
          proxyRes.on('data', (chunk) => {
            responseBody += chunk.toString();
            clientRes.write(chunk);
          });

          proxyRes.on('end', () => {
            logResponseBody(responseBody);
            logResponseEnd();
            clientRes.end();
          });
        }
      });

      proxyReq.on('error', (error) => {
        logError(reqId, error);
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Proxy error', message: error.message }));
      });

      // 发送请求体
      if (requestBody) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });

    clientReq.on('error', (error) => {
      logError(reqId, error);
    });
  });

  return server;
}

// ═══════════════════════════════════════════════════════════════
//  启动服务器
// ═══════════════════════════════════════════════════════════════

const server = createProxyServer();

server.listen(CONFIG.PORT, () => {
  console.log('\n' + chalk.bold.cyan('╔════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║') + '          🔍 LLM Proxy Server Started                           ' + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('╠════════════════════════════════════════════════════════════════╣'));
  console.log(chalk.bold.cyan('║') + chalk.yellow(` Listening on:     `) + chalk.green(`http://localhost:${CONFIG.PORT}`.padEnd(35)) + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('║') + chalk.yellow(` Proxying to:      `) + chalk.green(CONFIG.TARGET_URL.padEnd(35)) + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('╠════════════════════════════════════════════════════════════════╣'));
  console.log(chalk.bold.cyan('║') + chalk.gray(' Usage: Set your API base URL to http://localhost:' + CONFIG.PORT) + '    ' + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('╚════════════════════════════════════════════════════════════════╝\n'));
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\n🛑 Shutting down proxy server...\n'));
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});

