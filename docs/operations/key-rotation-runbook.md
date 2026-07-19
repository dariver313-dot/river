# djmima 密钥轮换运行手册

1. 生成新的 32 字节 Base64 密钥，并在受控密钥托管中保留旧密钥；不要提交到仓库或发送到聊天。
2. 将生产环境的 `VAULT_ENCRYPTION_KEYS` 配置为键 ID 到密钥的 JSON 映射，同时保留 `legacy` 与新键；设置 `VAULT_ACTIVE_KEY_ID` 为新键 ID。若平台不能读取旧密钥，可保留现有 `VAULT_ENCRYPTION_KEY`，另设新的 `VAULT_ACTIVE_ENCRYPTION_KEY` 与 `VAULT_ACTIVE_KEY_ID`。可选但推荐用独立的 `VAULT_AUDIT_SIGNING_KEY(S)` 管理审计签名。
3. 部署后，以管理员身份重新验证登录，调用受保护的密钥轮换批处理接口；每批最多处理 50 个项目。重复执行直到返回 `complete: true`。
4. 验证个人与公共项目、TOTP、审计签名和导出流程。至少保留旧密钥一个完整备份周期后，才可在下一次受控变更中移除。
5. 如果任一项目无法解密，立即停止轮换，恢复旧密钥映射并用隔离备份演练排查；不要删除或覆盖原密文。
