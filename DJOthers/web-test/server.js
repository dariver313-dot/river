const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

// 中间件
app.use(express.json());
app.use(express.static('public')); // 静态文件目录（稍后放 HTML）

// API 端点：检测 URL 列表
app.post('/api/check', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'Invalid input, expected array of URLs' });
    }

    // 规范化 URL（自动补全 https://）
    const normalizeUrl = (url) => {
        url = url.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return 'https://' + url;
        }
        return url;
    };

    // 并发检测（可控制并发数，这里简单用 Promise.all）
    const results = await Promise.all(urls.map(async (rawUrl) => {
        const targetUrl = normalizeUrl(rawUrl);
        const start = Date.now();
        try {
            const response = await axios.get(targetUrl, {
                timeout: 10000,        // 10秒超时
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            const status = response.status;
            const ok = status >= 200 && status < 400;
            return {
                rawUrl,
                targetUrl,
                ok,
                status,
                error: null,
                time: Date.now() - start
            };
        } catch (err) {
            let errorMsg = err.message;
            if (err.response) {
                // 服务器返回了错误状态码
                return {
                    rawUrl,
                    targetUrl,
                    ok: false,
                    status: err.response.status,
                    error: `HTTP ${err.response.status}`,
                    time: Date.now() - start
                };
            } else if (err.request) {
                // 请求发出但未收到响应
                errorMsg = err.code === 'ECONNABORTED' ? '请求超时' : '连接失败（网络问题或目标不可达）';
                return {
                    rawUrl,
                    targetUrl,
                    ok: false,
                    status: null,
                    error: errorMsg,
                    time: Date.now() - start
                };
            } else {
                return {
                    rawUrl,
                    targetUrl,
                    ok: false,
                    status: null,
                    error: errorMsg,
                    time: Date.now() - start
                };
            }
        }
    }));

    res.json(results);
});

// 启动服务
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});