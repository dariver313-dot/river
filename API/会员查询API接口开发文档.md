# 澳门娱乐城会员查询 API 开发文档

> 生成时间：2026-07-12（北京时间）  
> 平台：澳门娱乐城 `https://bm1.5vlk0.com`  
> 范围：仅包含会员资料、会员详情、会员等级/标签、会员登录记录等**只读查询**接口。  
> 验证方式：在已登录后台中依次进入“会员管理 -> 用户中心”、“权限管理 -> 登录日志”，执行账号查询并打开会员详情；通过浏览器 Network 实测抓取。  
> 脱敏说明：下文保留真实请求路径、方法、参数名、返回字段及完整对象层级；账号、姓名、电话、IP、设备 ID、订单号、支付密钥等真实值均替换为占位符。文档不保存 Token、Cookie、`md5Key`、公私钥或真实个人资料。

## 1. 通用约定

### 1.1 请求头

后台请求使用下列请求头名称，具体值由已登录会话维护，不应写死到机器人或客户端代码中：

```text
X-AUTH-TOKEN
X-TENANT-CODE
X-DEVICE-ID
X-TIMESTAMP
X-BG-REQ-ID
Request-Encrypt: true
lang: zh-CN
```

### 1.2 通用响应

所有已实测接口均会在 JSON 中带有业务状态，不能只根据 HTTP `200` 判定成功：

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false
}
```

调用方必须同时判断：`HTTP 2xx`、`success === true`、`code === "200"`。若出现 `success=false`、`code=403` 或 `retry=true`，应将其视为上游业务失败或授权失效，而不是空结果。

### 1.3 时间格式

| 页面/接口 | 实测格式 | 含义 |
|---|---|---|
| 用户中心列表 | `YYYY-MM-DD HH:mm:ss` | 当前页面用于注册时间筛选 |
| 登录日志 | 毫秒时间戳 | 以客户端选择的北京时间范围换算后提交 |
| 会员详情 | 无时间参数 | 按 `memberId` 查询当前完整资料 |

`startTime` 与 `endTime` 应成对传递，并校验开始时间不晚于结束时间。

## 2. 接口总览

| UI 入口 | 请求方法与地址 | 中文用途 | 是否直接返回会员资料 |
|---|---|---|---|
| 会员管理 -> 用户中心 -> 查询 | `POST /livepro/userCenter/getAllUsersByCondition` | 按账号、代理、时间及状态筛选会员列表 | 是，列表摘要 |
| 会员管理 -> 用户中心 -> 查询 | `POST /livepro/userCenter/getAllUsersByCondition/count` | 同步返回查询结果的人数和余额统计 | 否，统计摘要 |
| 用户中心 -> 点击会员账号 | `GET /livepro/userCenter/getUserDetails?memberId=...` | 获取单个会员完整资料 | 是，完整资料 |
| 打开会员详情 | `GET /livepro/memberLevel/getMemberLevelList` | 会员等级 ID 到名称的字典 | 否，辅助字典 |
| 打开会员详情 | `GET /livepro/memberLabel/getMemberLabelList` | 会员标签 ID 到名称的字典 | 否，辅助字典 |
| 权限管理 -> 登录日志 -> 查询 | `POST /livepro/authorization/getAppLog` | 按账号、IP、设备查询登录记录 | 是，登录行为资料 |

---

## 3. 会员列表查询

### 3.1 接口定义

```http
POST /livepro/userCenter/getAllUsersByCondition
Content-Type: application/json
```

后台入口：`会员管理 -> 用户中心 -> 查询`。

### 3.2 实测请求

```json
{
  "currentPage": 1,
  "pageSize": 50,
  "startTime": "2020-01-01 00:00:00",
  "endTime": "2026-07-12 23:59:59",
  "freezeStatus": 0,
  "memberName": "<会员账号>"
}
```

### 3.3 参数中文含义

| 参数 | 类型 | 本页面实测规则 | 中文含义 |
|---|---:|---|---|
| `currentPage` | number | 必传，实测为 `1` | 当前页码，从 1 开始 |
| `pageSize` | number | 必传，实测为 `50` | 每页记录数 |
| `startTime` | string | 页面默认携带 | 注册时间筛选起点，格式 `YYYY-MM-DD HH:mm:ss` |
| `endTime` | string | 页面默认携带 | 注册时间筛选终点，格式 `YYYY-MM-DD HH:mm:ss` |
| `freezeStatus` | number | 页面默认携带 `0` | 会员冻结状态；`0` 为未冻结/正常筛选 |
| `memberName` | string | 查询指定账号时传入 | 会员登录账号 |
| `agencyUsername` | string | API 支持，代理下级查询时使用 | 代理账号；不能用 `memberName` 代替 |

用户中心还提供用户类型、VIP、是否提款、在线状态、充值状态、所属上级、邀请码、余额、充值金额、未充值天数、未登录天数、备注、用户层级及标签等筛选控件。本次只针对“会员账号”进行了真实查询；未实际触发的控件参数不写入此接口契约，避免把前端猜测当成 API 事实。

### 3.4 实测完整响应结构（脱敏）

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false,
  "currentPage": 1,
  "pageSize": 50,
  "totalNum": "1",
  "totalPage": 1,
  "items": [
    {
      "memberId": "<会员ID>",
      "tenantCode": "<租户编码>",
      "memberAccno": "<会员数字账号>",
      "memberName": "<会员登录账号>",
      "nickname": "<会员昵称>",
      "realname": "<真实姓名>",
      "phone": "<已脱敏手机号>",
      "avatar": "<头像URL>",
      "vipLevel": 5,
      "agencyLevel": 0,
      "memberType": 3,
      "registerResource": "H5",
      "registerIp": "<注册IP>",
      "promotionCode": null,
      "registerAddress": "<注册地区>",
      "registerDevice": "<注册设备标识>",
      "latestLoginIp": "<最后登录IP>",
      "latestLoginAddress": "<最后登录地区>",
      "latestLoginTime": 1783832963000,
      "latestRechargeTime": 1783607798000,
      "latestLoginDevice": "<最后登录设备标识>",
      "remark": "<会员备注>",
      "freezeStatus": 0,
      "onlineStatus": 1,
      "killStatus": 0,
      "vipStatus": 0,
      "oneLevelAgencyId": "<一级代理ID>",
      "agencyMemberName": "<所属代理账号>",
      "twoLevelAgencyId": "0",
      "createTime": 1769155878000,
      "updateTime": 1783832963000,
      "balance": "0.004",
      "sumBet": "4270016.900",
      "xsFreezeStatus": 0,
      "muteStatus": 0,
      "isAgency": null,
      "canSendRedPacket": 1,
      "canReward": 1,
      "pointsAmount": "0.0",
      "profitAndLoss": "-123304.256",
      "finalAmount": "-499.000",
      "remainRepayAmount": "0.000",
      "remainAmount": "0.000",
      "levelId": "29",
      "birthday": null,
      "newWithdrawRolling": null,
      "tgId": null,
      "tgBindTime": null
    }
  ],
  "args": null
}
```

### 3.5 字段使用建议

| 字段组 | 可用于 | 注意事项 |
|---|---|---|
| `memberId/memberName/memberAccno` | 唯一定位会员 | 详情接口必须使用 `memberId` |
| `agencyMemberName` | 展示所属代理 | 仅表示上下级关系，不代表 IP/设备关联 |
| `register*`、`latestLogin*` | 注册与最近登录画像 | 仅是最近一条，不等于完整登录历史 |
| `balance/sumBet/profitAndLoss` | 列表展示、初步风控 | 金额均以字符串返回，客户端必须按金额解析，不能以字符串比较 |
| `freezeStatus/onlineStatus/muteStatus` | 账号状态展示 | 状态码应使用前端或平台定义映射，不能只靠数值猜测 |
| `tgId/tgBindTime` | TG 绑定状态 | `null` 表示无绑定资料，不等同于查询失败 |

---

## 4. 用户中心查询统计

### 4.1 接口定义

```http
POST /livepro/userCenter/getAllUsersByCondition/count
Content-Type: application/json
```

该接口由同一次“查询”自动并行发起，用于渲染用户中心顶部统计，不返回列表。

### 4.2 实测请求

```json
{
  "startTime": "2020-01-01 00:00:00",
  "endTime": "2026-07-12 23:59:59",
  "freezeStatus": 0,
  "value": "",
  "topAgencyName": "",
  "memberName": "<会员账号>"
}
```

| 参数 | 中文含义 |
|---|---|
| `startTime/endTime` | 与列表查询相同的注册时间范围 |
| `freezeStatus` | 账号冻结状态筛选 |
| `value` | 页面统计使用的附加筛选值；实测为空字符串 |
| `topAgencyName` | 顶级代理筛选；实测为空字符串 |
| `memberName` | 指定会员账号 |

### 4.3 实测完整响应结构（脱敏）

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false,
  "data": {
    "totalPerson": 1,
    "totalVisitor": 0,
    "totalAccount": 0,
    "totalRecharge": 1,
    "totalTest": 0,
    "totalChannel": 0,
    "totalSuper": 0,
    "userTotalBalance": "0"
  },
  "args": null
}
```

`totalPerson` 是当前条件下会员人数，`userTotalBalance` 是当前条件下会员余额汇总；其余统计字段须沿用后台业务口径，不应由机器人自行推断。

---

## 5. 会员完整详情

### 5.1 接口定义

```http
GET /livepro/userCenter/getUserDetails?memberId=<会员ID>
```

后台入口：`会员管理 -> 用户中心 -> 点击会员账号`。

### 5.2 参数

| 参数 | 类型 | 必填 | 中文含义 |
|---|---:|---:|---|
| `memberId` | string | 是 | 平台内部会员唯一 ID，由会员列表返回的 `items[].memberId` 获取 |

不要把 `memberName`、`memberAccno` 或 Telegram ID 当作 `memberId` 直接传入。

### 5.3 实测完整响应结构（脱敏）

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false,
  "data": {
    "memberName": "<会员登录账号>",
    "agencyMemberName": "<所属代理账号>",
    "nickname": "<会员昵称>",
    "memberType": 3,
    "vipLevel": 5,
    "balance": "0.004",
    "withdrawRolling": "0.000",
    "sumRolling": "4270016.900",
    "realName": "<真实姓名>",
    "bankList": [],
    "registerResource": "H5",
    "registerIp": "<注册IP>",
    "registerAddress": "<注册地区>",
    "registerDevice": "<注册设备标识>",
    "remark": "<会员备注>",
    "latestLoginDevice": "<最后登录设备标识>",
    "latestLoginIp": "<最后登录IP>",
    "latestLoginAddress": "<最后登录地区>",
    "latestLoginTime": 1783832963000,
    "latestRechargeTime": 1783607798000,
    "latestRechargeOrder": ["<最近充值订单对象，字段见 5.4>"],
    "latestWithdrawOrder": ["<最近提款订单对象，字段见 5.4>"],
    "createTime": 1769155878000,
    "updateTime": 1783832963000,
    "sumWithdraw": "-79800.000",
    "sumWithdrawTimes": 23,
    "firstWithdrawAmount": "-9400.000",
    "maxWithdrawAmount": "-10500.000",
    "sumRecharge": "203104.260",
    "profitAndLoss": "-123304.256",
    "sumRechargeTimes": 446,
    "firstRechargeAmount": "300.000",
    "maxRechargeAmount": "4000.000",
    "dailyRecharge": "0.000",
    "dailyRechargeTimes": 0,
    "dailyWithdraw": "0.000",
    "dailyWithdrawTimes": 0,
    "agAmount": "0",
    "kyAmount": "0",
    "aeAmount": "0",
    "ecAmount": "0",
    "mgAmount": "0",
    "jdbAmount": "0",
    "tyAmount": "0",
    "awcAmount": "0",
    "obAmount": "0",
    "obDjAmount": "0",
    "obZrAmount": "0",
    "sodeAmount": "0",
    "kmAmount": "0",
    "pokerAmount": "0",
    "pgAmount": "0",
    "ppAmount": "0",
    "cqAmount": "0",
    "lyAmount": "0",
    "sbAmount": "0",
    "sgAmount": "0",
    "imAmount": "0",
    "bgAmount": "0",
    "fbAmount": "0",
    "mtAmount": "0",
    "bbinAmount": "0",
    "fgAmount": "0",
    "psAmount": "0",
    "phone": "<已脱敏手机号>",
    "sumPromotion": "52643.138",
    "sumRecvTips": "0.000",
    "sumTips": "0.000",
    "sumRecvRedPackage": "1173.086",
    "sumRedPackage": "0.000",
    "sumRecommendBouns": "0.000",
    "sumRebate": "34065.222",
    "totalRebate": "34065.222",
    "onlineStatus": 1,
    "freezeStatus": 0,
    "couponAmountTotal": "0.000",
    "couponNumTotal": 0,
    "sumOperatorQtAdd": "0.000",
    "sumOperatorQtTimes": 0,
    "sumOperatorAdd": "0.000",
    "sumOperatorSubtract": "-700.000",
    "upgradeLevelTime": 1774781333000,
    "levelName": "VIP5",
    "levelId": "29",
    "labelId": "<标签ID>",
    "labelName": "<标签名称>",
    "labelCount": 1,
    "labelIds": "<标签ID列表>",
    "pointsAmount": "0.0",
    "channelCode": null
  },
  "args": null
}
```

### 5.4 最近充值/提款嵌套对象的完整字段

`latestRechargeOrder` 与 `latestWithdrawOrder` 是最近订单数组，不应被误认为“会员详情接口没有返回财务订单”。其中可能含有支付配置敏感字段，`auth-service` 对外必须做白名单裁剪。

| 数组 | 实测完整字段 |
|---|---|
| `latestRechargeOrder[]` | `orderNo, orderType, requestSeq, batchNumber, memberId, memberName, realName, vipLevel, amount, giveAmount, source, status, receivingName, receivingBank, receivingCardNo, payingName, payingBank, payingCardNo, payPlatformName, payPlatformCode, paywayId, paywayName, notifyUrl, md5Key, publicKey, privateKey, thirdNo, operatorId, operatorName, operationTime, postscript, remark, tenantCode, createTime, updateTime, payAmount, exchangeRate, exchangeAmount, type, proxyCode, sumRechargeTimes, abpayUrl, rechargeUrl, couponId, couponName, couponAmount` |
| `latestWithdrawOrder[]` | `requestSeq, orderNo, batchNumber, memberId, memberName, vipLevel, amount, source, status, recievingBindId, receivingName, receivingBank, receivingCardNo, payingName, payingBank, payingCardNo, operatorId, operatorName, operationTime, remark, tenantCode, createTime, updateTime, memberRemark, sumRecharge, sumWithdraw, rateType, paymentRate, paymentAmount, ifsc, notes, abpayType, proxyCode, walletUrl, paymentAgentId, paymentAgentName, labelName, loginIp, paymentType` |

**安全要求**：`md5Key`、`publicKey`、`privateKey`、完整卡号、收付款姓名、回调地址等字段不能转发给机器人、日志或群消息。会员详情适配层应只返回风控所需字段，例如金额、状态、渠道显示名、创建时间和备注。

### 5.5 详情字段的中文分组

| 分组 | 字段 |
|---|---|
| 身份与层级 | `memberName, agencyMemberName, nickname, memberType, vipLevel, levelName, levelId, labelId, labelName, labelCount, labelIds` |
| 资金与打码 | `balance, withdrawRolling, sumRolling, sumRecharge, sumRechargeTimes, sumWithdraw, sumWithdrawTimes, profitAndLoss` |
| 首次/最高/当日统计 | `firstRechargeAmount, maxRechargeAmount, dailyRecharge, dailyRechargeTimes, firstWithdrawAmount, maxWithdrawAmount, dailyWithdraw, dailyWithdrawTimes` |
| 注册与登录 | `createTime, updateTime, registerResource, registerIp, registerAddress, registerDevice, latestLoginTime, latestLoginIp, latestLoginAddress, latestLoginDevice` |
| 状态与备注 | `remark, onlineStatus, freezeStatus, pointsAmount, phone, channelCode` |
| 三方余额 | `agAmount, kyAmount, aeAmount, ecAmount, mgAmount, jdbAmount, tyAmount, awcAmount, obAmount, obDjAmount, obZrAmount, sodeAmount, kmAmount, pokerAmount, pgAmount, ppAmount, cqAmount, lyAmount, sbAmount, sgAmount, imAmount, bgAmount, fbAmount, mtAmount, bbinAmount, fgAmount, psAmount` |
| 奖励/优惠/人工账变 | `sumPromotion, sumRecvTips, sumTips, sumRecvRedPackage, sumRedPackage, sumRecommendBouns, sumRebate, totalRebate, couponAmountTotal, couponNumTotal, sumOperatorQtAdd, sumOperatorQtTimes, sumOperatorAdd, sumOperatorSubtract` |

---

## 6. 会员等级与标签字典

这两个接口由“打开会员详情”自动发起，作用是把 `levelId`、`labelId` 转换为中文名称。

### 6.1 会员等级列表

```http
GET /livepro/memberLevel/getMemberLevelList
```

无查询参数。实测响应：

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false,
  "items": [
    { "id": "<等级ID>", "name": "<等级名称>" }
  ],
  "args": null
}
```

### 6.2 会员标签列表

```http
GET /livepro/memberLabel/getMemberLabelList
```

无查询参数。实测响应：

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false,
  "items": [
    {
      "id": "<标签ID>",
      "name": "<标签名称>",
      "labelCount": 1,
      "labelIds": "<标签ID列表>",
      "type": "<标签类型>",
      "ruleType": "<规则类型>"
    }
  ],
  "args": null
}
```

建议在 `auth-service` 做短 TTL 内存缓存，例如 5 分钟；等级和标签不是每次会员详情都需要重新向上游取一次。

---

## 7. 会员登录日志与 IP/设备关联

### 7.1 接口定义

```http
POST /livepro/authorization/getAppLog
Content-Type: application/json
```

后台入口：`权限管理 -> 登录日志 -> 查询`。

### 7.2 按会员账号的实测请求

```json
{
  "currentPage": 1,
  "pageSize": 50,
  "startTime": 1783267200000,
  "endTime": 1783871999000,
  "memberName": "<会员账号>"
}
```

### 7.3 请求参数中文含义

| 参数 | 类型 | 规则 | 中文含义 |
|---|---:|---|---|
| `currentPage` | number | 必传，实测为 `1` | 当前页码 |
| `pageSize` | number | 必传，实测为 `50` | 每页登录记录数 |
| `startTime` | number | 建议与结束时间成对传入 | 开始毫秒时间戳 |
| `endTime` | number | 建议与开始时间成对传入 | 结束毫秒时间戳 |
| `memberName` | string | 与下列关联条件至少传一个 | 会员账号 |
| `loginIp` | string | 可选 | 登录 IP；用于按 IP 反查账号 |
| `device` | string | 可选 | 登录设备标识；用于按设备反查账号 |

`memberName`、`loginIp`、`device` 可以组合；组合时按交集筛选。调用时必须至少提供其中一个，禁止空条件全量拉取。

### 7.4 实测完整响应结构（脱敏）

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false,
  "currentPage": 1,
  "pageSize": 50,
  "totalNum": "9",
  "totalPage": 1,
  "items": [
    {
      "id": "<登录日志ID>",
      "memberId": null,
      "memberName": "<会员账号>",
      "loginTime": 1783832963000,
      "loginIp": "<登录IP>",
      "device": "<设备型号:设备标识>",
      "address": "<登录地区>",
      "loginResultDesc": "登录成功",
      "vipLevel": 5,
      "h5ReferDomain": null,
      "version": "<客户端版本>"
    }
  ],
  "args": null
}
```

### 7.5 正确的关联查询流程

1. 以提款时间所在的北京时间自然日为范围，仅传 `memberName`，获取该会员当天使用过的 IP 与设备。
2. 对每一个 IP，仅传 `loginIp` 回查账号。
3. 对每一个设备，仅传 `device` 回查账号。
4. 以账号去重，并排除提款会员本人、白名单账号和上级代理账号。
5. 按 `loginTime` 倒序，通知中最多展示固定数量，例如 5 个账号；完整名单仅在人工“团体画像”查询时读取。

自动风控规则应有时间范围；人工团体画像可省略时间范围，做全历史关联查询。二者语义不同，不能混用。

---

## 8. auth-service 适配建议

### 8.1 路由设计

建议维持“机器人只调用内部适配层，上游请求参数由适配层构造”的边界：

| 内部能力 | 上游接口 | 适配要求 |
|---|---|---|
| `getMemberInfo(memberName)` | 会员列表 | 强制账号非空；仅返回列表/风控需要字段 |
| `getUserDetails(memberId)` | 会员详情 | 必须先有 `memberId`；标记详情失败，不能静默用列表替代 |
| `getLoginLogs({ memberName/loginIp/device })` | 登录日志 | 校验三选一与时间成对规则；分页并保留 `loginTime` |
| `getMemberLevels()` | 等级字典 | 缓存；不下发敏感会话信息 |
| `getMemberLabels()` | 标签字典 | 缓存；不下发敏感会话信息 |

### 8.2 必须处理的边界

1. `getAllUsersByCondition` 的列表成功，不等于 `getUserDetails` 成功。风控依赖完整资金字段时，详情失败必须标记为数据不完整。
2. 所有金额是字符串，必须安全转成数值；`"0"`、`"0.000"` 不能被 JavaScript 的 `||` 错误地当作缺失值。
3. 详情中的最近充值订单可能含 `md5Key/publicKey/privateKey`。对外响应必须字段白名单裁剪。
4. 登录日志查询不带账号/IP/设备条件会扩大数据范围，适配层应直接返回 HTTP 400。
5. 业务授权失败可能仍是 HTTP 200，适配层应将 `success=false/code!=200/retry=true` 转成标准失败响应，而不是空数组。
6. 列表和登录日志都应根据 `totalPage` 或 `totalNum` 分页；不得假设单页足够。

## 9. 本次实测结论

- “用户中心查询”真实并行调用了**会员列表**和**查询统计**两个接口。
- 点击列表中的会员账号后，后台先取等级/标签字典，再以 `memberId` 调用完整详情接口。
- 会员详情确实包含注册 IP/设备、最近登录 IP/设备、资金汇总、等级标签和最近订单；其中最近订单包含不应外泄的支付配置字段。
- 登录日志接口可按账号、IP 或设备筛选，并返回精确 `loginTime`，适合作为同 IP/同设备风控关联的事实来源。
- 本文没有执行任何加款、扣款、审核、禁用、修改等级或其他写操作。
