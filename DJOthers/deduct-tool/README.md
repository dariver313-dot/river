# 余额扣除工具

## 使用方法

### 1. 安装依赖
```bash
npm install
```

### 2. 启动服务
```bash
npm start
```

### 3. 打开浏览器
访问 http://localhost:3000/tool2.html

### 4. 填写认证信息
在「认证信息」文本框粘贴3行内容：
```
SESSION=xxx
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...
8520
```
- 第1行：Cookie（从浏览器开发者工具的请求头中复制）
- 第2行：User-Agent
- 第3行：操作密码

### 5. 操作流程
1. 点击「查询会员」
2. 勾选需要扣除的记录（余额=0 和备注含"超过60天未登陆"的自动排除）
3. 点击「开始扣除」

## 文件说明
- `server.js` — 本地代理服务器（转发请求到目标服务器，解决Cookie跨域问题）
- `public/tool2.html` — 操作页面
