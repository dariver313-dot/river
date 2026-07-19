# djmima 自托管密码管理平台

`djmima` 是面向小型团队的 Web 密码库：个人项目仅本人可见；公共项目由管理员维护，所有已启用用户可查看。每条项目可保存账号、密码、备注与最多 3 组 TOTP 验证器配置。

## 自托管边界

- 应用、SQLite 数据库、加密密钥、登录会话、审计记录和备份都运行并保存在你的服务器。
- Docker 仅监听 `127.0.0.1:3101`；公网只经宝塔 Nginx 反向代理进入。
- Cloudflare 可以只作为 DNS、HTTPS 证书/WAF 的外部入口；它不参与应用计算，也不保存密码库数据。
- 本项目不是零知识密码管理器：服务器持有加密密钥，因此服务器本身必须受控、及时更新并限制 root 访问。

## 登录与权限

日常登录固定为三要素：

1. 登录邮箱（账户名）；
2. 登录密码（服务器只保存带随机盐的 scrypt 哈希）；
3. 本人设备上的 6 位 Google Authenticator 验证码。

第二位用户**不参与每次登录**。双人确认仅用于导出明文密码库等高风险操作，避免协作人不在时所有用户都无法登录。

管理员可在“用户管理”创建普通用户或管理员，并一次性交付该用户的初始登录密码和独立验证器 Setup Key。用户的 TOTP 密钥在 SQLite 中以 AES-GCM 密文保存。

## 首次部署

前置条件：Ubuntu 服务器、Docker Compose、宝塔 Nginx 站点及已签发的 `djmima.com` HTTPS 证书。

```bash
git clone --branch codex/selfhost --single-branch https://github.com/dariver313-dot/river.git /opt/djmima
cd /opt/djmima
node scripts/initialize-selfhost.mjs --email admin@example.com --origin https://djmima.com
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3101/api/health
```

初始化脚本只在服务器上创建权限为 `0600` 的 `.env`，其中包含所有密钥。它还会生成权限为 `0600` 的 `.selfhost-setup-url`；在服务器终端中查看该文件并在自己的浏览器打开一次性初始化地址：

```bash
cat .selfhost-setup-url
```

初始化页面会显示管理员自己的 Google Authenticator Setup Key，并要求设置管理员登录密码。录入验证器并确认后，该地址立即失效。不要把 `.env`、`.selfhost-setup-url`、密钥或 Setup Key 提交到 Git、截图或发送到普通聊天群。

在宝塔站点的“反向代理”中，将 `/` 转发至 `http://127.0.0.1:3101`，并使用 [`ops/selfhost/baota-nginx.conf`](ops/selfhost/baota-nginx.conf) 的安全头与敏感路径规则。

## 运行维护

```bash
# 查看应用日志和健康状态
docker compose logs --tail=100 djmima
docker compose ps
curl --fail http://127.0.0.1:3101/api/health

# 在容器内生成 SQLite 在线备份（保留最新 14 份）
docker compose exec -T djmima node scripts/selfhost-backup.mjs
```

备份文件位于 Docker 命名卷 `djmima_data` 的 `backups/` 目录。应再将**加密的服务器级备份**复制到另一处受控存储，并至少每月在隔离环境中恢复演练；恢复演练不得覆盖生产卷。

## 安全检查清单

- `.env` 与 `.selfhost-setup-url` 均仅限 root 读取，且永不进入 Git。
- 宝塔 Nginx 使用 HTTPS，反向代理传递 `X-Forwarded-Proto`、`X-Forwarded-Host` 与真实客户端 IP。
- 3001 不对公网开放；防火墙仅放行 80/443 和受限的管理端口。
- 为服务器、宝塔和 GitHub 分别启用 MFA，限制 root 密码登录，优先使用 SSH 密钥。
- 每次版本更新先执行 `docker compose build` 与 `/api/health` 健康检查，再切换反向代理；不要覆盖现有数据卷。
- 验证新增、编辑、删除、TOTP 读取、双人导出审批、会话超时和备份恢复。

## 本地验证

使用 Node.js 22 或更高版本：

```bash
npm ci
npm run build -- --webpack
npm run lint
```

生产镜像固定使用 Node 22。数据库结构与轻量迁移位于 `db/index.ts`，本地自托管数据默认位于 `.env` 指定的路径。
