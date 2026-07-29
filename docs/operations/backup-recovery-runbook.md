# djmima 自托管 SQLite 备份与恢复运行手册

## 目标与边界

- **RPO：24 小时；RTO：4 小时。** 每日至少创建一次 SQLite 在线备份，保留最近 14 份本地副本，并复制到独立的受控存储。
- 备份保存的是加密后的密码库记录、系统用户、审计记录及运行所需元数据；应用不提供数据库或明文数据导出，备份只能通过服务器受控流程处理。
- `.env` 中的加密密钥、审计签名密钥和数据库备份必须分别受控保存。缺少历史密钥时，旧项目无法解密。

## 每日备份

在服务器的应用目录执行：

```bash
docker compose exec -T djmima node scripts/selfhost-backup.mjs
```

脚本使用 SQLite 在线备份 API，不会通过复制正在写入的 WAL 文件来备份；完成后会执行 `PRAGMA integrity_check`，校验失败不会保留备份文件。默认 Compose 使用 `./data:/app/data` 绑定挂载，因此备份文件保存在服务器应用目录的 `./data/backups/`（容器内为 `/app/data/backups/`），本地仅保留最近 14 份。

### 启用每日定时任务

仓库提供每天 03:15（随机延迟最多 15 分钟）的 systemd 定时任务。首次部署后，以 root 执行：

```bash
install -m 0644 /opt/djmima/ops/selfhost/djmima-backup.service /etc/systemd/system/djmima-backup.service
install -m 0644 /opt/djmima/ops/selfhost/djmima-backup.timer /etc/systemd/system/djmima-backup.timer
systemctl daemon-reload
systemctl enable --now djmima-backup.timer
systemctl list-timers djmima-backup.timer
```

若实际安装目录不是 `/opt/djmima`，先修改 service 文件中的 `WorkingDirectory` 与 compose 文件路径。每次升级后至少执行一次 `systemctl start djmima-backup.service`，并使用 `journalctl -u djmima-backup.service -n 50 --no-pager` 确认成功。定时任务只负责在本机生成加密数据库备份；仍须按下述步骤将它复制到独立受控存储。

每日检查：

1. 确认最近备份不早于 24 小时，并记录时间、文件校验值与操作者；不要记录密钥或明文密码。
2. 将备份用服务器级加密复制到第二处受控存储。第二处可以是另一台自有服务器或受控的加密备份服务。
3. 确认 `.env` 已以独立受控方式备份；不能只备份数据库。
4. 备份失败时，暂停密钥轮换和批量删除，修复后补做一次隔离恢复演练。

## 月度隔离恢复演练

1. 选择最近一次成功备份，建立**新的、不可公网访问的**测试目录与独立数据目录；不得覆盖生产的 `./data/`。
2. 将备份恢复为测试目录中的 SQLite 文件，并仅在测试容器注入与该备份匹配的密钥。
3. 启动测试容器后验证：项目数量、个人/公共访问边界、一条密码解密、TOTP 配置读取、审计链状态、用户登录、国家变化邮箱确认与删除二次验证码。
4. 记录恢复开始/结束时间、备份标识、验证项目、结果与异常；完成后销毁隔离容器和临时访问权限。
5. 任一解密失败都视为恢复失败：保留现场，恢复对应历史密钥，禁止替换生产数据库或删除旧密钥。

## 生产事故恢复

1. 将站点访问范围缩至管理员，暂停数据写入并保存当前卷的只读副本。
2. 先在隔离环境恢复并完成上述验证；禁止直接把备份覆盖生产卷。
3. 仅在隔离验证成功后，按受控变更流程停止生产容器、替换数据库文件或切换到新卷。
4. 启动后先检查 `/api/health?mode=live`，再检查 `/api/health`、审计链、管理员账户、公共密码库映射与抽样解密；记录影响范围和补救措施。

## 禁止事项

- 不把密码明文、`.env`、TOTP Setup Key 或密钥写入工单、截图、仓库或普通聊天记录。
- 不在未完成隔离演练前覆盖生产数据库。
- 不在无法读取历史项目时删除旧密钥或旧备份。
