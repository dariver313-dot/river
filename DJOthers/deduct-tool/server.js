const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;
const TARGET = 'https://25wd69gg5k.com';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 代理：查询会员列表
app.post('/api/list', async (req, res) => {
  try {
    const { cookie, userAgent, ...params } = req.body;
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      formBody.append(key, String(value ?? ''));
    }

    const response = await fetch(`${TARGET}/agent/member/manager/list.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent || '',
        'Cookie': cookie || '',
      },
      body: formBody.toString(),
      redirect: 'manual',
    });

    if (response.status === 302 || response.status === 301) {
      return res.json({ error: '会话已过期，请更新Cookie', code: 302 });
    }
    const text = await response.text();
    try {
      res.json(JSON.parse(text));
    } catch {
      res.json({ error: '服务器返回非JSON，可能会话已过期', code: 302 });
    }
  } catch (e) {
    res.status(500).json({ error: '代理请求失败: ' + e.message });
  }
});

// 代理：查询账户详情
app.post('/api/detail', async (req, res) => {
  try {
    const { cookie, userAgent, account } = req.body;
    const timestamp = Date.now().toString();
    const url = `${TARGET}/agent/finance/memmnyope/memmny.do?account=${encodeURIComponent(account)}&_=${timestamp}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent || '',
        'Cookie': cookie || '',
      },
      redirect: 'manual',
    });

    if (response.status === 302 || response.status === 301) {
      return res.json({ error: '会话已过期，请更新Cookie', code: 302 });
    }
    const text = await response.text();
    try {
      res.json(JSON.parse(text));
    } catch {
      res.json({ error: '服务器返回非JSON，可能会话已过期', code: 302 });
    }
  } catch (e) {
    res.status(500).json({ error: '代理请求失败: ' + e.message });
  }
});

// 代理：扣除余额
app.post('/api/deduct', async (req, res) => {
  try {
    const { cookie, userAgent, ...params } = req.body;
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      formBody.append(key, String(value ?? ''));
    }

    const response = await fetch(`${TARGET}/agent/finance/memmnyope/save.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent || '',
        'Cookie': cookie || '',
      },
      body: formBody.toString(),
      redirect: 'manual',
    });

    if (response.status === 302 || response.status === 301) {
      return res.json({ error: '会话已过期，请更新Cookie', code: 302 });
    }
    const text = await response.text();
    try {
      res.json(JSON.parse(text));
    } catch {
      res.json({ error: '服务器返回非JSON，可能会话已过期', code: 302 });
    }
  } catch (e) {
    res.status(500).json({ error: '代理请求失败: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ 服务已启动: http://localhost:${PORT}`);
  console.log(`📖 打开浏览器访问: http://localhost:${PORT}/tool2.html`);
  console.log(`⏹ 按 Ctrl+C 停止服务`);
});
