# djmima 自托管密码管理平台

`djmima` 是部署在宝塔服务器上的团队密码库：个人项目仅本人可见；公共项目仅管理员可增删改，所有已启用用户可查看。每条项目可保存账号、密码、备注和最多 3 组 TOTP 验证器。

## 登录、风险控制与权限

登录需要登录账号、密码和本人 Google Authenticator 6 位验证码。登录账号可以是邮箱，或 4–32 位英文数字组合（以字母开头，且同时包含英文和数字）。

日常登录使用账号、密码和本人 Google Authenticator。系统不使用 IP 白名单或可信设备限制登录；仅通过服务器本地 GeoIP 数据库比较本次与上次成功登录的国家/地区代码。国家变化时，系统向已验证的安全邮箱发送一次性 8 位确认码，并以仅存在于本次登录流程中的随机绑定值防止确认码被跨流程复用。原始登录 IP 不会写入数据库或管理界面，也不会发送给第三方。

管理员新建用户时只填写登录账号、角色和安全邮箱。用户收到一次性激活码后自行设置登录密码并扫码配置 Google 验证器，完成验证码确认前账号保持“待激活”；激活码本身证明安全邮箱控制权。存量用户首次登录后必须验证安全邮箱才能进入系统。密码恢复码也只发送至安全邮箱；恢复密码会结束现有会话，但不会绕过 Google 验证器。变更已验证安全邮箱时，必须输入当前 Google 验证码并确认新邮箱，随后会结束旧会话。初始管理员在首次设置结束时会得到 10 个离线恢复码，必须离线保存；每个码只可使用一次，初始管理员不提供邮箱密码恢复。

应用会在空闲 15 分钟后登出，并在登录满 8 小时后强制重新登录。个人项目的增删改查仅依赖已登录的安全会话；公共项目的新增、修改和删除仅管理员可做，且每次变更均须输入操作者自己的 Google 6 位验证码。系统用户的新建、角色调整、启停、删除和验证器重置同样须本人 Google 验证码。管理员重置非初始管理员用户的验证器后，系统会立即撤销目标用户的登录与安全会话，并仅向其已验证的安全邮箱发送 15 分钟、一次性的恢复码；用户完成邮箱确认与新的 Google 验证器绑定后才能再次登录。初始管理员遗失验证器时请按照[验证器恢复手册](docs/operations/authenticator-recovery-runbook.md)处理。

数据导出功能不存在。数据库文件和备份只能在服务器受控运维流程中处理，不提供应用内导出接口。

## 首次部署

前置条件：Ubuntu 服务器、Node.js 22.13–24、Docker Compose、宝塔 Nginx 站点和已签发的 HTTPS 证书。Node 用于生成首次部署的受控 `.env`；仓库提供的 `compose.yaml` 只将应用映射到 `127.0.0.1:3101`，公网入口始终由宝塔 Nginx 提供。

```bash
git clone <你的仓库地址> /opt/djmima
cd /opt/djmima
node --version # 必须为 22.13–24
node scripts/initialize-selfhost.mjs --account admin@example.com --origin https://djmima.com
sudo chown -R 1001:1001 data
# 将本地 GeoLite2/GeoIP2 City MMDB 复制为 data/GeoLite2-City.mmdb，
# 并在 .env 填写 DJMIMA_SMTP_* 配置后再启动。
docker compose up -d --build
docker compose ps
curl --fail 'http://127.0.0.1:3101/api/health?mode=live'
```

初始化脚本会以 `0600` 权限创建 `.env` 和有效期一小时的一次性 `.selfhost-setup-url`。令牌位于 URL 片段中，不会发送至服务器访问日志；页面打开后会立即从地址栏清除。初始化前需将本地 GeoIP MMDB 放入 `data/GeoLite2-City.mmdb`，并填写 `.env` 中的 `DJMIMA_SMTP_*`。宝塔反向代理将 `/` 转发到 `http://127.0.0.1:3101`，并传递 `X-Forwarded-Proto`、`X-Forwarded-Host`、`X-Real-IP`。打开一次性初始化地址后，设置管理员密码和安全邮箱、离线保存恢复码，再用账号、密码和 Google 验证码登录并确认安全邮箱；确认前不能进入系统。完成后执行完整就绪检查：

```bash
curl --fail http://127.0.0.1:3101/api/health
```

`/api/health?mode=live` 仅用于容器存活检查，不依赖首次初始化、GeoIP 或 SMTP；`/api/health` 是上线就绪检查，任何必要认证依赖不可用时都会返回 503。

生产环境固定启用国家变化确认。部署前必须验证本地 GeoIP、SMTP 与安全邮箱收信；本地预览使用观察模式，不会因缺少 GeoIP 数据而阻断登录。

## 内嵌页面

初始管理员在“内嵌页面 → 可信来源”弹窗中，输入自己的 Google 6 位验证码后添加受信任的 HTTPS 域名来源，例如 `https://reports.example.com`。此操作立即生效，无需修改部署配置或重启服务。

来源配置完成后，管理员可在“系统 → 内嵌页面管理”中添加该来源下的具体 HTTPS 页面地址，指定全体用户或仅管理员可见、启用状态和排序。所有用户（包括管理员）在左侧主导航中直接打开已发布页面，右侧内容区仅展示对应页面；地址栏会保留当前选择的页面。服务端会拒绝任何未加入可信来源的地址；删除来源前必须先删除或迁移使用该来源的页面。嵌入框使用沙箱和无 Referrer 策略。请只添加你信任、且允许被 iframe 加载的站点。

## 运行维护

```bash
docker compose logs --tail=100 djmima
docker compose ps
curl --fail 'http://127.0.0.1:3101/api/health?mode=live'
curl --fail http://127.0.0.1:3101/api/health
docker compose exec -T djmima node scripts/selfhost-backup.mjs
npm run security:check
```

默认 Compose 将宿主机应用目录的 `./data/` 挂载到容器 `/app/data/`；备份文件因此位于宿主机 `./data/backups/`。应加密后复制到另一处受控存储，并定期在隔离环境中恢复演练，且不得覆盖生产数据目录。

首次上线后还应启用仓库提供的每日备份定时任务，具体安装和恢复演练步骤见 [备份与恢复运行手册](docs/operations/backup-recovery-runbook.md)。

## 安全检查清单

- `.env`、`.selfhost-setup-url` 与离线管理员恢复码仅限受控人员访问，且不进入 Git。
- 宝塔 Nginx 使用 HTTPS、传递真实客户端 IP；只开放 80/443 和受限管理端口。
- 每次升级先备份，再以已审查的提交 SHA 构建；基础镜像 digest 仅随明确审查的升级变更更新；不要覆盖现有 `./data/` 目录。
- 先检查 `/api/health?mode=live`，完成初始化和安全邮箱确认后再检查 `/api/health`。
- 使用真实 SMTP 与 GeoIP 验证首次地区基线、同国换网络、新国家邮箱确认、验证码过期和邮件不可用时拒绝登录。
- 验证账号激活、密码恢复不绕过 Google 验证器、验证器重置、15 分钟空闲登出、公共项目权限、删除验证码和内嵌来源限制。
- 至少完成一次隔离备份还原，确认数据库、匹配的 `.env` 密钥和离线恢复码分别受控保存。

## 本地验证

```bash
npm ci
npm run build -- --webpack
npm run lint
npm run security:check
```
