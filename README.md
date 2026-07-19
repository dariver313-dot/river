# djmima 密码管理平台

面向小型团队的 Web 密码库：个人项目仅本人可见；公共项目由管理员维护，已启用用户可查看。项目可保存账号、密码、备注与最多 3 个 TOTP 验证器配置；敏感字段以 AES-GCM 加密后写入 D1。

## 上线前必须配置

在 Sites 的生产环境变量中至少配置以下变量：

| 变量 | 类型 | 用途 |
| --- | --- | --- |
| `PRIMARY_ADMIN_EMAIL` | 普通变量 | 首位且受保护的主管理员邮箱，必须与该用户用于 ChatGPT 登录及站点访问控制的邮箱一致。 |
| `VAULT_ENCRYPTION_KEY` | 密钥变量 | 32 字节、Base64 或 Base64URL 编码的 AES-256-GCM 密钥。 |
| `VAULT_AUDIT_SIGNING_KEY` | 密钥变量（推荐） | 32 字节、Base64 或 Base64URL 编码的审计 HMAC 密钥；未配置时会从加密密钥派生，仅用于兼容。 |

可在 PowerShell 生成新的密钥：

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

**请妥善保存密钥。** 新项目会使用 AES-GCM 关联数据绑定其 `vault_id` 与 `item_id`，并记录密钥版本。轮换时使用 `VAULT_ENCRYPTION_KEYS`（键 ID 到密钥的 JSON 映射）和 `VAULT_ACTIVE_KEY_ID`，先保留旧密钥、完成重加密、验证备份后才可移除旧键。不要把任何密钥提交到仓库、截图、聊天记录或前端配置中。

密码库首页会在读取数据前校验该密钥是否存在且可解析为 32 字节；配置错误会显示管理员可处理的提示，而不会等到首次写入时才失败。

首次访问时，系统只会按 `PRIMARY_ADMIN_EMAIL` 创建主管理员；不会把第一位访问者自动设为管理员。主管理员进入“用户管理”后创建其他管理员或普通用户；同时还必须在 Sites 的访问控制中允许相同邮箱访问。

公共密码库不会由普通用户的首次访问自动初始化。管理员创建第一条公共项目后，公共区域才会出现；此后所有已启用用户可以查看，只有管理员可以维护。

## 部署检查清单

- `.openai/hosting.json` 已声明 D1 绑定 `DB`，并已将 Drizzle 迁移一起发布。
- 生产环境已配置上述变量，且加密与审计密钥均以密钥形式保存。
- Sites 访问控制仅授予需要使用系统的邮箱；应用内“已启用”状态不替代站点访问控制。
- 使用主管理员账户完成一次登录，创建一位普通用户并验证其只能读取公共项目。
- 用测试项目验证新增、编辑、删除、TOTP 读取、双人确认导出、服务端会话超时与重新验证。
- 按 [备份与恢复运行手册](docs/operations/backup-recovery-runbook.md) 建立 D1 定期备份和月度隔离恢复演练；密钥要在独立的受控托管中恢复。

## 安全边界

- 登录由 Sites 的 ChatGPT 身份机制处理，应用不接收或保存登录密码。
- 写入接口强制校验 `Origin` 与 `Sec-Fetch-Site`，限制 JSON 请求大小，并对读取、写入、审计和敏感操作分别按用户及边缘 IP 限流。
- 安全会话由 HttpOnly、SameSite=Strict Cookie 与 D1 同步维护；每次 API 请求都会续期检查，空闲 15 分钟后服务端拒绝访问。用户管理、删除、公开发布、导出和密钥轮换需要最近 10 分钟内重新验证的会话。
- 审计记录使用 HMAC 签名和每个密码库独立的顺序哈希链，可发现已签名记录的修改、插入和大多数缺失；要抵御数据库管理员整体回滚，仍需遵守备份留存与外部受控归档流程。
- 单个个人密码库最多 500 项、公共密码库最多 1,000 项，系统用户最多 100 位；这些限制在服务端执行。
- 这不是端到端、零知识密码管理器：生产运行环境持有加密密钥，因此应仅部署在受信任的受控环境中。

## 本地验证

使用 Node.js 24（仓库中的 `.nvmrc` / `.node-version` 已固定该版本；Node.js 20 无法构建此项目）：

```bash
npm run build
npm test
npm run lint
npm run security:check
```

每次推送和 Pull Request 都会在 Node.js 24 中运行构建、测试与 ESLint。数据库结构在 `db/schema.ts`，生产迁移在 `drizzle/`；迁移文件应经过审查后直接提交，避免把不必要的迁移生成工具带入生产开发依赖。
