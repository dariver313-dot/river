# 澳博国际会员查询 API 开发文档

> 生成时间：2026-07-12（北京时间）  
> 平台：澳博国际 `https://cf-admin.ahoub1999.com`  
> 范围：仅包含会员搜索、会员详情、会员等级、登录设备与登录信息等**只读会员查询**接口。  
> 验证方式：已登录后台中进入“账号管理 -> 会员管理”和“账号管理 -> 登录设备管理”，使用只读样本账号触发搜索和详情；由浏览器 Network 实测抓取。  
> 脱敏说明：本文保留请求路径、方法、字段、对象层级和业务含义；账号、姓名、手机号、IP、设备号、银行卡、税号、社交账号及会话凭据均使用占位符，不保存真实生产数据。

## 1. 通用约定

### 1.1 鉴权请求头

浏览器请求使用登录会话，主要请求头名称如下。`auth-service` 应从环境配置与 Token 管理器取得值，不能把实际值写入机器人、日志或本文档。

```text
Authorization: Bearer <JWT>
Cookie: token=<JWT>; logtoken=<访问日志令牌>; ...
X-Time-Zone: Asia/Shanghai
Langue: zh-CN
```

### 1.2 通用响应

平台 A 的业务成功需要同时满足 `HTTP 2xx`、`code === 0` 和 `succeed === true`：

```json
{
  "code": 0,
  "traceId": null,
  "message": "Success",
  "data": {},
  "succeed": true
}
```

业务失败也可能使用 HTTP `200` 返回，因此调用方不能把“HTTP 成功”当作“会员查询成功”。

### 1.3 时间和标识

| 项目 | 实测格式/来源 | 说明 |
|---|---|---|
| 会员详情路径 ID | `member/list` 返回的 `records[].id` | 这是详情接口 `/member/details/{id}` 实际使用的内部 ID，不要误用界面展示的“会员ID”文字值。 |
| 详情页登录信息时间 | `YYYY-MM-DD HH:mm:ss` | 详情页默认最近 30 天。 |
| 登录设备列表 | 不带时间范围 | 仅返回设备号和使用该设备的会员数。 |
| 风控登录关联 | 仍使用 `/api/admin/report/ip/page` | 该接口支持账号、IP、设备和时间范围；`pageDevice` 不能代替它。 |

---

## 2. 接口总览

| 后台入口 | 请求方法与地址 | 中文用途 | 建议给机器人开放 |
|---|---|---|---|
| 账号管理 -> 会员管理 -> 搜索 | `POST /api/admin/member/list` | 按会员账号筛选会员列表 | 是，字段白名单后开放 |
| 会员管理 -> 点击会员账号 | `GET /api/admin/member/details/{id}` | 后台会员详情抽屉 | 否，原始响应含银行卡、税号、联系方式等敏感资料 |
| 打开会员详情 | `GET /api/admin/member/level/list` | 会员等级字典 | 可缓存后开放 |
| 打开会员详情 | `GET /api/admin/member/device/user/loginInfoCount` | 单会员近 30 天登录设备/IP/时间 | 可做受控的内部查询 |
| 账号管理 -> 登录设备管理 -> 搜索 | `GET /api/admin/member/device/pageDevice` | 按账号查询设备号及关联会员数量 | 可做受控的内部查询 |

会员详情页同时会发起投注、代理、充提、奖励统计请求。这些属于注单/财务/代理数据，不纳入本“会员信息查询”文档，也不应因为打开详情页面就全部透传给机器人。

---

## 3. 会员列表查询

### 3.1 接口定义

```http
POST /api/admin/member/list
Content-Type: multipart/form-data; boundary=...
```

后台入口：`账号管理 -> 会员管理 -> 搜索`。

**实测结论**：后台使用 `multipart/form-data` 提交筛选条件。不要把该请求改成旧资料中的 GET；也不建议只把参数拼在 URL 查询串中。

### 3.2 实测请求字段

```text
flag=0
baseSearchType=8
baseSearchFuzzy=0
otherSearchType=0
accountSearchType=2
current=1
size=10
account=<会员账号>
```

| 字段 | 类型 | 中文含义 | 规则 |
|---|---:|---|---|
| `flag` | number | 后台固定筛选标记 | 页面固定传 `0`，由适配器写死 |
| `baseSearchType` | number | 基础搜索模式 | 页面固定传 `8`，不由机器人覆盖 |
| `baseSearchFuzzy` | number | 基础搜索是否模糊匹配 | 页面固定传 `0`，精确匹配 |
| `otherSearchType` | number | 其他搜索模式 | 页面固定传 `0` |
| `accountSearchType` | number | 会员账号搜索类型 | 页面固定传 `2` |
| `current` | number | 当前页码 | 从 `1` 开始 |
| `size` | number | 每页数量 | 页面实测为 `10` |
| `account` | string | 会员账号 | 查询单个会员时必传 |
| `superAccount` | string | 上级代理账号 | 代理下级查询使用；`account` 必须为空 |

会员管理页面还提供会员 ID、代理 ID、代理账号、游戏账号、会员姓名、手机号、注册 IP、注册域名、会员层级、首次存款时间等筛选项。本次只对“会员账号”完成真实查询，未把未验证的前端字段猜测成接口契约。

### 3.3 实测完整响应结构（脱敏）

```json
{
  "code": 0,
  "traceId": null,
  "message": "Success",
  "data": {
    "records": [
      {
        "realName": "<真实姓名>",
        "nickname": "<会员昵称>",
        "dialCode": "+86",
        "phone": "<手机号>",
        "taxType": "<税号类型>",
        "taxNum": "<税号>",
        "email": "<邮箱>",
        "wechat": "<微信>",
        "qq": "<QQ>",
        "tikTok": "<TikTok>",
        "facebook": "<Facebook>",
        "google": "<Google账号>",
        "zalo": "<Zalo>",
        "zaloAreaCode": "<Zalo区号>",
        "zaloPhone": "<Zalo手机号>",
        "cnpjTaxNum": "<CNPJ税号>",
        "telegramCode": "<Telegram区号>",
        "telegram": "<Telegram>",
        "telegramAccount": "<Telegram账号>",
        "whatsCode": "<WhatsApp区号>",
        "whatsApp": "<WhatsApp>",
        "cardNo": "<卡号>",
        "bankCard": "<银行卡/钱包地址>",
        "cardHolder": "<持卡人>",
        "fullName": "<完整姓名>",
        "id": 123456,
        "brandId": 100,
        "popularizeId": 0,
        "account": "<会员账号>",
        "vipLevel": 4,
        "remark": "<会员备注>",
        "parentId": 0,
        "parentPopularizeId": 0,
        "parentName": "<上级代理账号>",
        "userType": "<账户类型>",
        "superPath": "<代理层级路径>",
        "userLevel": "<会员层级>",
        "lowerNum": 0,
        "withdrawFlag": 1,
        "currency": "CNY",
        "balance": 599.842,
        "freeze": 0,
        "gameFreeze": 0,
        "totalRechAmount": 94103,
        "totalRechTimes": 153,
        "totalWithdrawAmount": -83954,
        "totalWithdrawTimes": 87,
        "registerIp": "<注册IP>",
        "registerIpCount": 1,
        "createTime": 1760000000000,
        "invitationCode": "<邀请码>",
        "registerHost": "<注册域名>",
        "registerSource": "<注册来源>",
        "status": 1,
        "online": 0,
        "lastLoginIp": "<最后登录IP>",
        "lastLoginIpCount": 1,
        "lastLoginTime": 1780000000000,
        "lastLoginDeviceClientId": "<最后登录设备标识>",
        "agentLevel": "<代理等级>",
        "registerBrowser": "<注册浏览器>",
        "registerDeviceClientId": "<注册设备标识>",
        "registerDeviceCount": 1,
        "registerOs": "<注册操作系统>",
        "growth": 0,
        "goldCoin": 0,
        "salaryFlag": 0,
        "balanceDifference": 10149,
        "winAmount": -14061.444,
        "waterAmount": 1837.164,
        "betAmount": 455120,
        "validAmount": 455120,
        "iconId": null,
        "adSource": 0,
        "adInfo": null,
        "registerMode": "<注册方式>",
        "validAmountToday": 0,
        "validAmountHistory": 455120,
        "winAmountToday": 117.18,
        "winAmountHistory": -14061.444,
        "waterAmountToday": 1.704,
        "waterAmountHistory": 1837.164,
        "bonusAmountToday": 2,
        "bonusAmountHistory": 2495.13,
        "exceptionRechargeTotalAmount": 0,
        "exceptionWithdrawTotalAmount": 0,
        "commissionAmountToday": 0,
        "commissionAmountHistory": 2.288,
        "inviter": "<邀请人>",
        "interestAmount": 0,
        "firstRechTime": 1760000000000,
        "firstRechAmount": 100,
        "firstWithdrawTime": 1760000000000,
        "firstWithdrawAmount": -1400,
        "lastRechTime": 1780000000000,
        "lastRechAmount": 200,
        "thirdSource": "<三方来源>",
        "appVersion": "<APP版本>"
      }
    ],
    "total": 1,
    "size": 10,
    "current": 1,
    "orders": [],
    "optimizeCountSql": true,
    "searchCount": true,
    "optimizeJoinOfCountSql": true,
    "countId": null,
    "maxLimit": null,
    "pages": 1
  },
  "succeed": true
}
```

### 3.4 字段中文分组

| 分组 | 关键字段 | 中文意义 |
|---|---|---|
| 身份与上级 | `id, account, nickname, parentName, parentId, popularizeId, userType, userLevel, vipLevel` | 会员身份、代理归属、账户层级 |
| 资金与行为 | `balance, totalRechAmount, totalRechTimes, totalWithdrawAmount, totalWithdrawTimes, balanceDifference, betAmount, validAmount, winAmount` | 余额、累计充提、净额、投注及输赢 |
| 注册与登录 | `registerIp, registerDeviceClientId, createTime, lastLoginIp, lastLoginDeviceClientId, lastLoginTime, online` | 注册和最后登录画像 |
| 奖励与佣金 | `waterAmount*, bonusAmount*, commissionAmount*, interestAmount` | 返水、红利、佣金、利息相关金额 |
| 高敏感资料 | `realName, phone, taxNum, email, social accounts, cardNo, bankCard, cardHolder` | 仅后台人工查看；不能透传给机器人 |

---

## 4. 会员详情

### 4.1 接口定义

```http
GET /api/admin/member/details/{id}
```

后台入口：`会员管理 -> 点击会员账号`。

路径中的 `{id}` 必须使用列表响应 `data.records[].id`。实测点击会员账号后使用的正是该字段。

### 4.2 实测完整响应结构（脱敏）

```json
{
  "code": 0,
  "traceId": null,
  "message": "Success",
  "data": {
    "realName": "<真实姓名>",
    "nickname": "<昵称>",
    "dialCode": "+86",
    "phone": "<手机号>",
    "taxType": "<税号类型>",
    "taxNum": "<税号>",
    "email": "<邮箱>",
    "wechat": "<微信>",
    "qq": "<QQ>",
    "tikTok": "<TikTok>",
    "facebook": "<Facebook>",
    "google": "<Google账号>",
    "zalo": "<Zalo>",
    "zaloAreaCode": "<Zalo区号>",
    "zaloPhone": "<Zalo手机号>",
    "cnpjTaxNum": "<CNPJ税号>",
    "telegramCode": "<Telegram区号>",
    "telegram": "<Telegram>",
    "telegramAccount": "<Telegram账号>",
    "whatsCode": "<WhatsApp区号>",
    "whatsApp": "<WhatsApp>",
    "cardNo": "<卡号>",
    "bankCard": "<银行卡/钱包地址>",
    "cardHolder": "<持卡人>",
    "fullName": "<完整姓名>",
    "brandId": 100,
    "id": 123456,
    "account": "<会员账号>",
    "userLevel": "<会员层级>",
    "userType": "<账户类型>",
    "status": 1,
    "withdrawFlag": 1,
    "sex": "<性别>",
    "birthday": "<生日>",
    "parentId": 0,
    "parentName": "<上级代理>",
    "invitationCode": "<邀请码>",
    "balance": 599.842,
    "commissionBalance": 0,
    "rebate": 0,
    "totalRechAmount": 94103,
    "totalRechTimes": 153,
    "totalWithdrawAmount": -83954,
    "totalWithdrawTimes": 87,
    "lastRechTime": 1780000000000,
    "firstRechAmount": 100,
    "firstRechTime": 1760000000000,
    "lastWithdrawTime": 1780000000000,
    "language": "zh-CN",
    "registerIp": "<注册IP>",
    "registerHost": "<注册域名>",
    "registerSource": "<注册来源>",
    "registerBrowser": "<注册浏览器>",
    "registerOs": "<注册操作系统>",
    "createTime": 1760000000000,
    "lastLoginTime": 1780000000000,
    "lastLoginIp": "<最后登录IP>",
    "remark": "<会员备注>",
    "vipLevel": 4,
    "totalWealAmount": 0,
    "vipGrowth": 0,
    "superPath": "<上级路径>",
    "agentLevel": "<代理等级>",
    "tableIndex": 0,
    "goldCoin": 0,
    "salaryFlag": 0,
    "currency": "CNY",
    "thirdGoogle": null,
    "thirdFacebook": null,
    "bankCardList": [
      {
        "realName": "<真实姓名>", "nickname": "<昵称>", "dialCode": "+86", "phone": "<手机号>",
        "taxType": "<税号类型>", "taxNum": "<税号>", "email": "<邮箱>",
        "wechat": "<微信>", "qq": "<QQ>", "tikTok": "<TikTok>", "facebook": "<Facebook>",
        "google": "<Google账号>", "zalo": "<Zalo>", "zaloAreaCode": "<Zalo区号>", "zaloPhone": "<Zalo手机号>",
        "cnpjTaxNum": "<CNPJ税号>", "telegramCode": "<Telegram区号>", "telegram": "<Telegram>",
        "telegramAccount": "<Telegram账号>", "whatsCode": "<WhatsApp区号>", "whatsApp": "<WhatsApp>",
        "cardNo": "<卡号>", "bankCard": "<银行卡/钱包地址>", "cardHolder": "<持卡人>", "fullName": "<完整姓名>",
        "id": 1, "popularizeId": 0, "memberId": 123456, "account": "<会员账号>",
        "bankName": "<银行名称>", "bankCode": "<银行编码>", "address": "<开户行地址>", "network": "<网络>",
        "alias": "<别名>", "type": "<账户类型>", "currency": "CNY", "isDefault": 0, "remark": "<备注>",
        "createBy": "<创建人>", "createTime": 1760000000000, "updateBy": "<更新人>", "updateTime": 1760000000000,
        "tarCurrency": "<目标币种>", "withdrawCardBindType": "<绑卡类型>", "ifscCode": "<IFSC>",
        "beneficiaryType": "<受益人类型>", "beneficiaryId": "<受益人ID>", "beneficiaryBankType": "<受益银行类型>", "qrCode": "<二维码>"
      }
    ],
    "popularizeId": 0,
    "adInfo": null,
    "mspribeMinLimit": 0,
    "mspribeMaxLimit": 0,
    "proxyWallet": 0
  },
  "succeed": true
}
```

### 4.3 安全结论

该接口的 `data` 和 `bankCardList` 同时包含银行卡/钱包地址、税号、联系方式和社交账号。它适合后台人工详情页，**不适合**直接暴露为通用机器人接口。

`auth-service` 当前不新增该上游接口；机器人仍使用经过字段白名单的 `member/list`，已经足够支撑风控和加款前资料核验。

---

## 5. 会员等级字典

### 5.1 接口定义

```http
GET /api/admin/member/level/list
```

打开会员详情时自动发起，无请求参数。

### 5.2 实测响应

```json
{
  "code": 0,
  "traceId": null,
  "message": "Success",
  "data": [
    {
      "id": 1,
      "levelName": "<等级名称>",
      "levelValue": 1,
      "totalRechTimes": 0,
      "totalRechAmount": 0,
      "memberNum": 0,
      "memberLockNum": 0,
      "dayOfWithdraw": 0,
      "locked": 0,
      "status": 1,
      "isWithdraw": 1,
      "isDefault": 0,
      "cashMessage": "<提现提示>",
      "isAuto": 0
    }
  ],
  "succeed": true
}
```

建议在 `auth-service` 缓存 5 分钟。它仅用于展示 `vipLevel` 或等级配置，不需要每个会员请求一次。

---

## 6. 会员详情页近 30 天登录信息

### 6.1 接口定义

```http
GET /api/admin/member/device/user/loginInfoCount
```

打开会员详情后自动发起。后台实测查询范围为近 30 天。

### 6.2 实测请求

```text
startTime=2026-06-12 00:00:00
endTime=2026-07-12 23:59:59
userId=<member/list 返回的 records[].id>
username=<会员账号>
```

| 参数 | 中文含义 |
|---|---|
| `startTime/endTime` | 登录记录时间范围，格式 `YYYY-MM-DD HH:mm:ss` |
| `userId` | 平台内部会员记录 ID，来自列表 `records[].id` |
| `username` | 会员账号；与 `userId` 一起限定查询对象 |

### 6.3 实测响应

```json
{
  "code": 0,
  "traceId": null,
  "message": "Success",
  "data": [
    {
      "id": 1,
      "brandId": 100,
      "popularizeId": 0,
      "username": "<会员账号>",
      "deviceName": "<设备名称>",
      "deviceClientId": "<设备标识>",
      "deviceUserAgent": "<User-Agent>",
      "deviceOsType": "<操作系统/设备类型>",
      "ip": "<登录IP>",
      "lastLoginTime": "2026-07-10 17:56:02",
      "userCount": 1
    }
  ],
  "succeed": true
}
```

此接口适合“会员自身近期登录设备”展示，但不适合直接用于完整关联账号反查：返回数据没有关联账号列表，也没有分页信息。

---

## 7. 按账号查询设备列表

### 7.1 接口定义

```http
GET /api/admin/member/device/pageDevice
```

后台入口：`账号管理 -> 登录设备管理 -> 搜索`。

### 7.2 实测请求

```text
isDetail=0
current=1
size=10
account=<会员账号>
```

| 参数 | 中文含义 |
|---|---|
| `isDetail` | 页面固定为 `0` 的设备列表模式 |
| `current/size` | 页码和每页数量 |
| `account` | 会员账号 |

### 7.3 实测响应

```json
{
  "code": 0,
  "traceId": null,
  "message": "Success",
  "data": {
    "records": [
      {
        "id": 1,
        "deviceClientId": "<设备标识>",
        "deviceNum": 4
      }
    ],
    "total": 4,
    "size": 10,
    "current": 1,
    "orders": [],
    "optimizeCountSql": true,
    "searchCount": true,
    "countId": null,
    "maxLimit": null,
    "pages": 1
  },
  "succeed": true
}
```

`deviceNum` 表示使用该设备的会员数量。它可以作为“公共设备”快速筛除依据，但没有返回关联账号与登录时间，不能替代风控现有的 `/api/admin/report/ip/page` 关联查询。

---

## 8. auth-service 与 AB_Riskbot 落地结论

### 已修改

1. 平台 A `memberInfo` 和代理下级会员查询已改为与后台一致的 `POST multipart/form-data` 请求。
2. 会员列表返回已经做字段白名单：保留余额、充提次数与金额、投注/输赢、上级、层级、注册和最后登录 IP/设备等机器人需要字段。
3. 手机号、姓名、税号、银行卡/钱包地址、社交账号等不再通过通用会员查询接口下发。
4. 平台 B 会员详情同样已移除最近充值/提款订单、支付密钥和银行卡相关原始对象。
5. `TG_Riskbot` 已修复 `VIP0` 被错误替换为等级 ID 的边界，并删除依赖敏感最近订单、且未启用的充值渠道缓存规则。

### 保持不变

1. `AB_Riskbot` 的同 IP/同设备风控继续调用 `/api/admin/report/ip/page`。该接口可按账号、IP、设备和时间范围查询，语义比本次抓到的设备汇总接口更适合风控关联。
2. 不新增 `/member/details/{id}` 的通用转发路由。该接口返回的敏感数据超过机器人业务需要。
3. 会员列表的固定搜索模式参数由 `auth-service` 生成，机器人仅传账号或代理账号，避免前端内部枚举扩散到各机器人。

## 9. 本次实测范围声明

已实际触发：会员账号搜索、点击会员账号详情、会员等级字典、详情页近 30 天登录信息、登录设备管理账号搜索。  
未执行：新增、编辑、冻结、停用、拉黑、充值、提现、审核、导出、清除联系方式、批量操作及任何其他写操作。
