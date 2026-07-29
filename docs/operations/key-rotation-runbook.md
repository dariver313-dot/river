# djmima 密钥轮换运行手册

1. 生成新的 32 字节 Base64 密钥，并在受控密钥托管中保留旧密钥；不要提交到仓库或发送到聊天。
2. 将生产环境的 `VAULT_ENCRYPTION_KEYS` 配置为键 ID 到密钥的 JSON 映射，同时保留 `legacy` 与新键；设置 `VAULT_ACTIVE_KEY_ID` 为新键 ID。若平台不能读取旧密钥，可保留现有 `VAULT_ENCRYPTION_KEY`，另设新的 `VAULT_ACTIVE_ENCRYPTION_KEY` 与 `VAULT_ACTIVE_KEY_ID`。可选但推荐用独立的 `VAULT_AUDIT_SIGNING_KEY(S)` 管理审计签名。
3. 当前版本不提供应用内密钥轮换或数据迁移接口。不要仅通过切换活动密钥来尝试轮换；必须先在隔离副本中完成受控迁移方案与恢复演练，再安排维护窗口。
4. 验证个人与公共项目、TOTP 与审计签名。至少保留旧密钥一个完整备份周期后，才可在下一次受控变更中移除。
5. 如果任一项目无法解密，立即停止维护操作，恢复旧密钥映射并用隔离备份演练排查；不要删除或覆盖原密文。
