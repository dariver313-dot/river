# 两个平台 API 接口文档（脱敏实测版）

> 更新时间：2026-07-11（北京时间）  
> 数据来源：已登录后台的真实只读请求、后台前端状态常量、`auth-service` 与四个机器人的当前代码。  
> 安全说明：本文不保存 Token、Cookie、账号密码、TOTP、真实会员资料、银行卡或服务器入口。

## 1. 文档范围与参数约定

本文仅覆盖 `auth-service` 与四个机器人实际需要的接口。查询接口已使用用户指定的两个只读样本账号实测，并与后台前端使用的状态常量交叉核对；加款、审核、修改余额等写接口未实际执行。

参数分为四类：

- **必填**：缺少时请求没有明确业务目标，应直接拒绝。
- **可选**：不传时使用已写明的默认值。
- **条件必填**：一组参数至少提供一个，例如账号、IP、设备。
- **固定**：由 `auth-service` 内部写入，机器人不应覆盖。

调用方传入了无效参数时，不应静默改用默认值；应返回 HTTP 400，并说明具体字段。

---

## 2. 平台 B：澳门娱乐城（livepro）

### 2.1 鉴权与通用响应

Base URL：`https://bm1.5vlk0.com`

浏览器真实请求使用以下请求头（仅列名称）：

- `X-AUTH-TOKEN`
- `X-TENANT-CODE`
- `X-DEVICE-ID`
- `X-TIMESTAMP`
- `X-BG-REQ-ID`
- `Request-Encrypt: true`
- `lang: zh-CN`

响应通常经过 SM4-ECB 加密，密钥由当前 Token 派生。解密后的通用成功结构：

```json
{
  "success": true,
  "code": "200",
  "msg": "success",
  "retry": false,
  "history": false
}
```

分页响应增加：

```json
{
  "currentPage": 1,
  "pageSize": 50,
  "totalNum": "1",
  "totalPage": 1,
  "items": []
}
```

重要：上游会以 HTTP 200 返回业务授权失败，例如：

```json
{
  "success": false,
  "code": "403",
  "msg": "授权错误，请点击重试~",
  "retry": true
}
```

因此不能只判断 HTTP 状态，必须在解密后检查 `success/code/retry`。

### 2.2 会员账号查询（加款后台权限）

```http
GET /livepro/memberAccount/list
```

参数：

| 参数 | 类型 | 规则 |
|---|---:|---|
| `currentPage` | number | 可选，默认 1 |
| `pageSize` | number | 可选，默认 50 |
| `memberName` | string | 必填，会员账号 |

用途：TG_Robot 加款前确认账号并取得 `accountId/memberId`。

实测说明：当前风控后台会话调用该接口返回业务 `403`。该接口需要加款后台地址或具备对应菜单权限的操作员 Token；不能用风控后台健康状态推断它一定可用。

### 2.3 批量人工加款（写接口，未执行）

```http
POST /livepro/memberAccount/updateBalance
```

请求结构（来自现有生产代码，未进行真实加款验证）：

```json
{
  "totalNum": 1,
  "transDetail": "礼金",
  "transType": 174,
  "effecRolling": 1,
  "rollingRate": "1",
  "remark": "礼金",
  "operatorRemark": "<活动备注>",
  "googleCode": "<TOTP>",
  "list": [
    { "memberName": "<会员账号>", "amount": 88 }
  ]
}
```

`transType=174` 等业务参数固定，不应由机器人任意传入。上线前仍需要一份脱敏的真实成功响应和真实失败响应，才能确定唯一可靠的成功条件。

### 2.4 通用会员查询与代理下级查询

```http
POST /livepro/userCenter/getAllUsersByCondition
```

按会员查询：

```json
{
  "currentPage": 1,
  "pageSize": 50,
  "memberName": "<会员账号>"
}
```

按代理查询下级：

```json
{
  "currentPage": 1,
  "pageSize": 50,
  "agencyUsername": "<代理账号>"
}
```

`memberName` 与 `agencyUsername` 语义不同。实测同一个代理值：

- 使用 `agencyUsername` 返回该代理的大量下级会员。
- 错用 `memberName` 只会搜索同名账号。

主要返回字段：

`memberId, memberName, nickname, realname, vipLevel, memberType, registerIp, registerDevice, latestLoginIp, latestLoginTime, latestLoginDevice, agencyMemberName, createTime, balance, sumBet, profitAndLoss, remark, freezeStatus`

### 2.5 会员完整详情

```http
GET /livepro/userCenter/getUserDetails?memberId=<memberId>
```

`memberId` 必填，通常先通过 2.4 查询获得。

主要返回字段分组：

- 身份：`memberName, agencyMemberName, nickname, memberType, vipLevel, realName`
- 资金：`balance, sumRecharge, sumRechargeTimes, sumWithdraw, sumWithdrawTimes, profitAndLoss`
- 打码：`withdrawRolling, sumRolling`
- 注册：`createTime, registerResource, registerIp, registerDevice`
- 登录：`latestLoginTime, latestLoginIp, latestLoginDevice, latestLoginAddress`
- 备注与状态：`remark, freezeStatus, onlineStatus, labelName`
- 奖励：`sumPromotion, sumRecvTips, sumRecvRedPackage, sumRedPackage, sumRecommendBouns, sumRebate`
- 最近订单：`latestRechargeOrder, latestWithdrawOrder`

该接口失败时不能把会员搜索列表当作“完整详情成功”，否则财务字段缺失会影响风控。

### 2.6 提现订单列表

```http
GET /livepro/withdraw/list
```

参数：

| 参数 | 类型 | 规则 |
|---|---:|---|
| `currentPage` | number | 可选，默认 1 |
| `pageSize` | number | 可选 |
| `status` | number | 条件参数，含义见下表 |
| `timeType` | number | 按具体页面用途固定，风控查询使用 0 |
| `startTime` | number | 毫秒时间戳 |
| `endTime` | number | 毫秒时间戳 |
| `memberName` | string | 查询单个会员历史时提供 |
| `memberType` | number | 某些统计场景使用 |

提款状态码：

| `status` | 含义 |
|---:|---|
| 0 | 待扣款 |
| 1 | 待处理 |
| 2 | 处理中 |
| 3 | 拒绝 |
| 4 | 成功 |
| 5 | 核对中 |
| 6 | 批量处理中 |
| 7 | 代付中 |
| 8 | 代付成功 |
| 9 | 代付失败 |

风控机器人轮询 `[1, 2]`，即待处理和处理中；历史成功提款应识别 `4` 与 `8`，不能只认单一成功码。

分页返回结构为平台 B 通用分页结构，另有 `sumAmount, giveAmount, sumAmountGroupByStatus`。实测记录完整字段：

`requestSeq, orderNo, batchNumber, memberId, memberName, vipLevel, amount, source, status, recievingBindId, receivingName, receivingBank, receivingCardNo, payingName, payingBank, payingCardNo, operatorId, operatorName, operationTime, remark, tenantCode, createTime, updateTime, memberRemark, sumRecharge, sumWithdraw, rateType, paymentRate, paymentAmount, ifsc, notes, abpayType, proxyCode, walletUrl, paymentAgentId, paymentAgentName, labelName, loginIp, paymentType`

### 2.7 彩票投注记录

```http
POST /livepro/bets/list
```

```json
{
  "currentPage": 1,
  "pageSize": 200,
  "startTime": 0,
  "endTime": 0,
  "timeType": 0,
  "memberName": "<会员账号>",
  "issue": "",
  "memberType": "",
  "paymentType": "",
  "seriesTag": ""
}
```

`timeType=0` 固定。注单状态码：

| `status` | 含义 | 是否属于正常已结算注单 |
|---:|---|---|
| 2 | 待开奖 | 否 |
| 3 | 开奖中 | 否 |
| 5 | 未中奖 | 是 |
| 6 | 已中奖 | 是 |
| 7 | 打和 | 是 |
| 10 | 已撤单 | 否 |
| 11 | 处理失败 | 否 |
| 12 | 扣款失败 | 否 |
| 20 | 异常订单 | 否 |
| 21 | 已取消 | 否 |

`statusDesc` 在真实返回中可能为 `null`，必须根据数值状态映射，不能依赖描述字段。

实测记录完整字段：

`deductBatchNumber, orderNo, orderSource, memberId, lotteryId, memberName, memberNickName, playClassName, playClassTag, amount, issue, lotteryName, status, statusDesc, winAmount, profit, willAmount, lotteryNo, seriesTag, createTime, updateTime, lotteryTime, source, numbers, betsPoint, tenantCode, playName, couponAmount, couponId, memberCouponId, version, paymentType, isPush, isBackgroundPush, agencyMemberName`

### 2.8 彩票投注汇总

```http
POST /livepro/bets/count
```

参数与 2.7 的筛选条件相同，不带分页。实测 `data` 字段：

`numberCount, countAmount, realAmount, countWin, countProfit, countMember`

### 2.9 第三方游戏订单

```http
POST /livepro/thirdgame/queryOrder
```

```json
{
  "currentPage": 1,
  "pageSize": 200,
  "memberName": "<会员账号>",
  "timeType": 0,
  "startTime": 0,
  "endTime": 0,
  "type": 18
}
```

风控机器人使用 `type=18`。旧资料中的其他 `type/type2` 组合属于不同后台页面场景，不能混用。

上游限制：单次查询区间不能超过 1 个月；超过时以 HTTP 200 返回业务失败 `code=21002`。`auth-service` 必须识别该业务失败，不能包装成查询成功。

通用三方订单 `orderStatus`：`0=未结算, 1=已结算, 2=已撤单`。FB 类数据使用单独映射：`0/1/4=未结算, 2=已拒单, 3=已取消, 5=已结算`，不能与通用映射混用。

实测记录完整字段：

`memberId, memberName, uname, orderNo, bet, allbet, winAmount, profit, betTime, settleTime, updateTime, orderStatus, tenantCode, isPush, subRespList, competitionName, source`

`subRespList` 项字段：`gameName, playName, betContent, betResult, competitionName`。

### 2.10 支付/充值订单

```http
GET /livepro/paymentOrder/list
```

风控查询成功充值时固定：`orderType=0, timeType=0, status=0000`。

可变参数：`currentPage, pageSize, startTime, endTime, memberName`。

充值状态码：

| `status` | 含义 |
|---|---|
| `5555` | 已申请 |
| `1111` | 待审核；支付场景显示“等待支付” |
| `0000` | 充值成功；支付场景显示“支付成功” |
| `2222` | 充值失败；支付场景显示“支付失败” |
| `6666` | 取消支付 |

分页返回另有 `sumAmount, giveAmount, sumAmountGroupByStatus`。实测记录完整字段：

`orderNo, orderType, requestSeq, batchNumber, memberId, memberName, realName, vipLevel, amount, giveAmount, source, status, receivingName, receivingBank, receivingCardNo, payingName, payingBank, payingCardNo, payPlatformName, payPlatformCode, paywayId, paywayName, notifyUrl, md5Key, publicKey, privateKey, thirdNo, operatorId, operatorName, operationTime, postscript, remark, tenantCode, createTime, updateTime, payAmount, exchangeRate, exchangeAmount, type, proxyCode, sumRechargeTimes, abpayUrl, rechargeUrl, couponId, couponName, couponAmount`

注意：上游响应包含 `md5Key/publicKey/privateKey` 等敏感字段。机器人当前不需要这些字段，`auth-service` 对外返回前应做字段白名单裁剪。

### 2.11 人工充值汇总

```http
POST /livepro/accountChange/sum/amount
```

```json
{
  "startTime": 0,
  "endTime": 0,
  "memberName": "<会员账号>",
  "transTypeList": [254]
}
```

`transTypeList=[254]` 固定，返回 `data.sumAmount`。

### 2.12 彩金/账变明细

```http
POST /livepro/accountChange/List
```

TG_Robot 查询活动加款记录时使用：

```json
{
  "currentPage": 1,
  "pageSize": 200,
  "startTime": 0,
  "endTime": 0,
  "memberName": "<会员账号>",
  "transTypeList": [174],
  "memberTypeList": []
}
```

主要返回字段：`id, memberId, memberName, transType, amount, oldBalance, newBalance, operatorRemark, operatorName, createTime, memberType, transSeq, transDesc, transDetail`。

`174` 与 2.11 的 `254` 是不同业务类型，不能统一成一个值。

### 2.13 登录日志及同 IP/同设备查询

```http
POST /livepro/authorization/getAppLog
```

公共参数：`currentPage, pageSize, startTime, endTime`。

筛选参数：`memberName, loginIp, device` 至少提供一个；允许组合，组合时按交集收窄结果。

关联查询应分三步：

1. 仅按 `memberName` 查询会员在时间范围内使用的 IP 和设备。
2. 对每个 IP，仅传 `loginIp` 反查账号。
3. 对每个设备，仅传 `device` 反查账号。

主要返回字段：`id, memberName, loginTime, loginIp, device, address, loginResultDesc, vipLevel, h5ReferDomain, version`。

平台 B 明确返回 `loginTime`，可以按最近登录时间排序。

### 2.14 彩票与三方投注报表

```http
POST /livepro/tenantMemberCpReport
POST /livepro/tenantMemberThirdReport
```

公共参数：`currentPage, pageSize, startTime, endTime, memberName`。其中日期格式为 `YYYY-MM-DD`。

彩票报表字段：`dataTime, memberName, memberType, lotteryId, lotteryName, num, betAmount, winAmount, profit`。

三方报表字段：`dataTime, gameType, thirdgameType, memberName, memberType, betAmount, winAmount, profit, num`。

实测 `pageSize=500` 可以正常返回 500 的分页设置；仍应根据 `totalPage` 判断是否需要继续翻页。

### 2.15 会员进出报表汇总

```http
POST /livepro/tenantMemberInOutReportCount
```

```json
{
  "startTime": "YYYY-MM-DD",
  "endTime": "YYYY-MM-DD",
  "memberType": "",
  "memberName": "<会员账号>",
  "profitSort": null
}
```

返回字段包括各游戏类别的投注、中奖、盈亏和注单数，以及：`rechargeAmount, withdrawAmount, activityAmount, balance, profit, negativeProfit, withdrawCash, withdrawLottery, withdrawGift`。

### 2.16 WebSocket 域名

```http
GET /livepro/platform/domain/list?currentPage=1&pageSize=100&status=1&domainType=2
```

返回字段：`tenantCode, domainName, domainUrl, status, domainType, sort, remark`。

---

## 3. 平台 A：澳博国际（cf-admin）

### 3.1 鉴权与通用响应

Base URL：`https://cf-admin.ahoub1999.com`

请求使用：

- `Authorization: Bearer <JWT>`
- 登录会话 Cookie（包含 token/logtoken）
- `X-Time-Zone: Asia/Shanghai`
- `langue: zh-CN`

通用成功结构：

```json
{
  "code": 0,
  "traceId": null,
  "message": "Success",
  "data": {},
  "succeed": true
}
```

必须同时检查 HTTP 状态、`code===0` 和 `succeed===true`。

### 3.2 会员账户详情（加款前查询）

```http
GET /api/admin/member/getAccountDetail
```

参数：`account` 必填；`popularizeId` 可为空；`currency=CNY` 固定。

用途：TG_Aobo 检查账号并取得 `id/nickname`。主要字段：`id, account, nickname, balance, parentName, totalRechAmount, totalWithdrawAmount, lastLoginIp, createTime, remark`。

### 3.3 手工加款（写接口，未执行）

```http
POST /api/admin/finance/rechargeOrder/manual
```

参数来自现有生产代码，包括 `memberId, nickname, remarks, discountAmount, discountType=888, discountDml, skipAuditing=true, currency=CNY, gs=<TOTP>`。

没有进行真实加款测试，也没有得到完整的真实成功/失败响应；上线前必须补充脱敏响应样本，不能只凭 HTTP 2xx 判断成功。

### 3.4 会员列表与代理下级

```http
POST /api/admin/member/list
```

按会员：使用 `account=<会员账号>`。

按代理下级：使用 `superAccount=<代理账号>`，并令 `account` 为空。

公共固定参数：`flag=0, baseSearchType=8, baseSearchFuzzy=0, otherSearchType=0, accountSearchType=2`。

主要返回字段：`id, popularizeId, account, parentName, vipLevel, balance, totalRechAmount, totalRechTimes, totalWithdrawAmount, totalWithdrawTimes, registerIp, createTime, lastLoginIp, lastLoginTime, lastLoginDeviceClientId, balanceDifference, winAmount, validAmount, remark, status`。

### 3.5 提款订单分页

```http
POST /api/admin/finance/memberWithdraw/page
```

参数：`current, size, cashStatusList, createTimeFrom, createTimeTo`；固定 `order=DESC, flag=0`。

时间文档格式为 `YYYY-MM-DD HH:mm:ss`。auth-service 对外若接收毫秒时间戳，应在适配层统一转换。

提款状态码：

| `cashStatus` | 含义 |
|---:|---|
| 0 | 处理中 |
| 1 | 未受理 |
| 2 | 已受理 |
| 3 | 已出款 |
| 4 | 已取消 |
| 5 | 已拒绝 |

待处理风控轮询 `[1, 2]` 是正确的。返回 `data.records`，主要字段包括：`cashOrderNo, memberId, account, cashMoney, cashStatus, createTime, superName, bankName, realName, bankCard, accountMoney, userRemark`。

本轮指定样本账号没有提款记录，因此记录字段沿用已登录后台的先前只读样本和前端表格定义；状态码来自当前后台前端常量。

### 3.6 彩票投注记录

```http
GET /api/admin/lot/bet/queryPage
```

参数：`account, betStartTime, betEndTime, current, size`；风控查询固定 `status=1, currency=CNY, summary=true`；官彩筛选时增加 `gameId`。

注单状态：`0=未开奖, 1=已开奖, 2=已撤销, 3=已删除, 4=取消追号`。中奖结果是另一个字段：`result: 0=未中奖, 1=已中奖, 2=和局`。两者不能混为一个状态。

返回 `data.page.records` 和汇总 `data.otherData`。

实测记录完整字段：

`orderNo, userId, account, superName, userName, fullName, userType, cateCode, cateName, betInfo, betInfoName, currency, walletType, fixedMultiple, model, money, validAmount, betModel, multiple, totalNums, totalMoney, odds, oddsName, rebate, rebateMoney, companyRebate, companyRebateMoney, gameId, gameName, issueNum, openNum, openNumJson, openNumTemplate, openTime, statTime, betStartTime, betEndTime, winCount, status, reward, payoutAmount, drawMoney, result, betTime, createTime, updateTime, settleTime, winnableAmount, traceOrderNo, recoverMoney, followCode, popularizeId`

返回结构为 `data.page.records` 加汇总 `data.otherData`。当前 `auth-service` 固定 `status=1`，因此 AB_Riskbot 不会取得撤销、删除或未开奖注单。

### 3.7 各类游戏有效投注分析

```http
GET /api/admin/member/dayReport/findMemberbetAnalysis
```

必填：`account, startTime, endTime`；固定 `isTrue=0`。

`brandId=100` 实测为可选：带与不带均返回成功且字段结构相同，不应标记为必填。

返回七类游戏的 `*ValidAmount, *WinAmount, *OrderCount` 以及 `allWinAmount`。

### 3.8 会员充值汇总报表

```http
GET /api/admin/report/data/findRechReport
```

参数：`account, startTime, endTime`；固定 `flag=0, currency=CNY`。

返回字段：`allRechAmount, allRechCount, bankMoney, onlineMoney, handMoney, firstRechMoney, secondRechMoney, exceptionRechAmount, virtualRechMoney, commissionAmount` 及对应计数字段。

### 3.9 充值订单分页

```http
POST /api/admin/finance/rechargeOrder/page
```

注意：旧文档索引写成 GET，但实测 GET 返回 HTTP 405，POST 返回成功。应以 POST 为准。

充值状态码：`1=未处理, 2=已处理, 3=已入款, 4=已取消`。

参数：`account, current, size, createTimeFrom, createTimeTo`；风控成功充值查询固定 `statusList=3, order=DESC, memberType=M, fullNameFuzzy=false, flag=0`。

上游实测同时接受日期时间字符串和毫秒时间戳。

返回 `data.records` 和 `data.otherData`。实测记录完整字段：

`id, brandId, account, nickname, balance, superAccount, orderNo, payTypeName, payAccountAccount, payAccountOwner, payAccountBankName, tpInterfaceName, tpMerchantName, tpPayChannelName, tpOrderNo, amount, payAmount, discountAmount, discountType, totalAmount, discountDml, rechargePerson, rechargeTime, status, remarks, acceptAccount, acceptTime, auditorAccount, auditTime, auditRemarks, ipAddress, createTime, memberType, memberLevel, vipLevel, mode, payType, memberId, pointFlag, currencyRate, currencyCount, currency, fee, taxNumber, iconIds, rechargeVoucher, rechargeCard, cardPwd, popularizeId, parentPopularizeId, iconId, userRemark`

### 3.10 充值历史订单

```http
POST /api/admin/finance/rechargeOrderHistory/page
```

普通充值历史固定参数：`orderBy=auditTime, order=DESC, status=3, currency=CNY, modeList=2, pointFlag=1, memberType=M`。

账号筛选必须同时传：

```text
userAccount=<会员账号>
account=<会员账号>
```

实测结果：同时传入两个账号字段时返回该会员的少量记录；仅传 `userAccount` 会返回数千条大范围记录。因此不能省略 `account`。

彩金历史使用：`modeList=2,3, discountTypes=888, account=<会员账号>`。

主要记录字段：`account, superAccount, orderNo, payTypeName, tpInterfaceName, tpMerchantName, tpPayChannelName, amount, payAmount, discountAmount, totalAmount, status, remarks, auditTime, auditRemarks, createTime, mode, payType, memberId, vipLevel, userRemark`。

### 3.11 登录 IP/设备记录

```http
GET /api/admin/report/ip/page
```

公共固定参数：`type=2`；分页参数：`current, size`；时间格式：`beginTime/endTime = YYYY-MM-DD HH:mm:ss`。

筛选参数：`account, loginIp, deviceClientId`。关联查询与平台 B 相同，应先按账号，再分别按 IP 和设备反查。

返回字段：`account, popularizeId, ipAddress, ipCount, loginAddress, deviceClientId, offline, uuid, brandId`。

上游响应不包含单条 `loginTime`。因此平台 A 只能确认时间范围内的关联账号，不能依据本接口精确按最近登录时间排序；这是上游字段限制。

---

## 4. 经实测确认的文档纠错

1. 平台 A `/finance/rechargeOrder/page` 必须使用 POST，不是 GET。
2. 平台 A `findMemberbetAnalysis` 的 `brandId` 可省略。
3. 平台 A 充值历史必须同时提供 `userAccount` 与 `account` 才能准确限定会员。
4. 平台 B 查询代理下级必须传 `agencyUsername`，不能用 `memberName` 代替。
5. 平台 B 登录日志筛选项至少提供 `memberName/loginIp/device` 之一。
6. 平台 B 风控后台 Token 对 `/memberAccount/list` 可能没有权限；加款账号查询应使用加款后台地址及对应权限。
7. 平台 B `tenantMemberCpReport/tenantMemberThirdReport` 实测可接受 `pageSize=500`。
8. 平台 A 充值订单实测可接受日期时间字符串或毫秒时间戳。

---

## 5. auth-service 对外参数设计建议

1. 每条路由定义独立 DTO，不做任意参数透传。
2. 固定参数只在平台适配器中生成，机器人不传。
3. 可选参数只有在“未提供”时使用默认值；提供但无效应返回 400。
4. 时间必须成对提供并验证 `start <= end`。
5. 分页统一为正整数，并根据上游 `totalPage/pages` 决定是否继续翻页。
6. 查询结果统一为 `{ success, data, error, upstreamCode, retryable }`。
7. 上游业务失败不能包装成外层 `success:true`。
8. 加款成功必须依据接口特定业务字段确认，不能只看 HTTP 2xx 或通用 `code`。

---

## 6. auth-service 实测对照结论

以下结论来自当前代码与已登录平台的只读实测对照。标为“上游限制”的项目不建议在 `auth-service` 中伪造或推断数据。

> 2026-07-11 实施状态：本节列出的账号过滤、代理字段、业务失败识别、提款时间、查询失败语义、注单状态、三方时间上限、敏感字段裁剪、Token 恢复、双后台健康检查、限流隔离、持久化幂等、WS Token 权限和登录日志参数校验均已落实到 `auth-service`。两个真实加款接口按要求未执行，因此“加款专用成功字段”仍保持为待实测确认项，未凭空改写成功条件。

### 6.1 上线前应优先修复

| 优先级 | 位置 | 问题与实测依据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P0 | `src/platforms/platform-a.ts` 的 `getRechargeHistory` | 当前只传 `userAccount`。实测仅传该字段返回大范围记录；同时传 `userAccount` 与 `account` 才准确限定会员。 | 风控可能读取其他会员充值记录，误判近期充值、充值渠道和套利规则。 | 增加 `account: params.account`，并为账号过滤增加回归测试。 |
| P1 | `src/platforms/platform-b.ts` 的 `getMembersByAgency` | 当前把代理账号放入 `memberName`。实测正确筛选字段是 `agencyUsername`。 | 调用该接口时得到会员本人或错误结果，而不是代理下级。 | 改为 `agencyUsername: params.agencyUsername`。 |
| P1 | 两个平台的通用 `request()` | 平台 A 只处理业务 401；平台 B 在 SM4 解密前检查业务 401，解密后直接返回。实测平台 B 会出现 HTTP 200、业务 `code=403/success=false`。 | 上游拒绝、权限不足或业务失败可能被外层包装成 `success:true`。 | 在解密/解析完成后统一校验各平台业务响应；保留 `upstreamCode/msg/retry`，失败时抛出类型化错误。 |
| P1 | `src/api.ts` 的平台 A 提款订单路由 | 路由仅接受毫秒时间戳，但 AB_Riskbot 实际传 `YYYY-MM-DD HH:mm:ss`；无效值被静默忽略。 | 机器人要求的查询时间范围失效，退回上游默认范围。 | 该路由明确接受日期时间字符串并严格校验，或统一要求机器人传毫秒时间戳；提供但无效必须返回 400。 |
| P1 | 两个平台的 `checkUser` | 除 Token 错误外，网络错误、权限错误、业务错误均被转换成 `exists:false`。 | “查询失败”会被误判为“会员不存在”，影响加款流程。 | 返回 `exists/error` 的可区分状态；批量查询失败时整体报错或逐项返回 `queryFailed:true`。 |
| P1 | 两个平台的加款成功判断 | 平台 A 对请求未抛错就返回 `ok:true`；平台 B 仍接受通用 `success=true/code=200`。写接口未实测，尚不能证明这些字段等于实际入账成功。 | 存在“接口受理或业务失败但机器人显示成功”的风险。 | 取得一份真实成功和一份真实失败响应后，只认接口专用成功字段；在此之前不要扩大成功条件。 |
| P1 | TG_Riskbot 彩票注单状态 | 平台 B `/bets/list` 未限定状态，TG_Riskbot 映射记录时又丢弃 `status`。 | 待开奖、撤单、处理失败、扣款失败、异常或取消注单可能进入彩票违规规则。 | 保留 `status`，规则分析前只接受正常已结算状态 `5/6/7`；异常状态如需单独风控，应建立独立规则。 |
| P1 | 平台 B 三方订单时间范围 | 上游明确限制单次区间不超过 1 个月，超限返回 HTTP 200 + `code=21002`。 | 调用方若传更长范围，当前通用响应处理可能把失败包装成成功空数据。 | 路由限制最大 31 天，超限直接 400；同时校验解密后的业务成功字段。 |
| P1 | 平台 B 充值订单敏感字段 | 上游记录包含 `md5Key, publicKey, privateKey`，机器人并不需要。 | 原样透传会扩大支付配置泄露面。 | `auth-service` 使用字段白名单，只返回风控和机器人需要的订单字段。 |

### 6.2 可靠性与安全优化

| 优先级 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| P1 | `src/token-manager.ts`、`src/index.ts` | 定时刷新返回 `null` 时不会切换到 5 分钟重试；首次自动登录失败时也不会启动后续刷新计划。 | 将空结果视为失败；只要配置完整就启动调度，成功恢复常规间隔，连续失败达到阈值后明确告警。 |
| P1 | `src/platforms/platform-b.ts` 的 `getMemberInfo` | 详情接口失败时静默降级为搜索结果，调用方无法知道财务字段不完整。 | 返回 `partial:true` 与缺失字段，或对依赖详情的风控调用直接失败，避免用不完整数据评分。 |
| P1 | 平台 B 健康检查 | 当前只验证风控后台的会员搜索，不能证明加款后台及 `/memberAccount/*` 权限可用。 | 分别报告 `riskApi`、`robotApi`、`token`；加款健康检查使用只读的加款后台接口。 |
| P2 | `src/api.ts` 速率限制 | 查询、金融、管理限制共用同一个以 API Key 为键的计数器。 | 键中加入类别，例如 `query:<key>`、`finance:<key>`、`admin:<key>`，避免相互占用额度。 |
| P2 | `src/api.ts` 金融幂等 | 幂等记录只在内存保存，进程重启后丢失。 | 对加款使用 SQLite/Redis 等持久化幂等记录，保存请求摘要、状态和上游结果。 |
| P2 | `/platform-b/ws-token` | 任意有效只读 Key 都可取得平台 B Token。TG_Riskbot 的直连 WS 功能需要保留，但权限范围过宽。 | 给 TG_Riskbot 使用独立权限或独立 Key 白名单，不向其他只读机器人开放。 |
| P2 | 两个平台登录日志路由 | 未强制至少提供账号、IP、设备中的一个筛选项；无效可选参数会被静默省略。 | 增加 one-of 校验、时间成对校验和 `start <= end` 校验，防止意外大范围查询。 |
| P2 | 对外响应格式 | 目前混用 `{success,data}`、`{ok,err}`，上游业务码也未稳定透出。 | 统一响应契约：`{success,data,error,upstreamCode,retryable,partial}`。 |

### 6.3 已确认不是代码问题

1. 平台 A `findMemberbetAnalysis` 不传 `brandId` 仍可成功，当前无需强制补充。
2. 平台 A `rechargeOrder/page` 使用 POST 是正确实现；旧文档中的 GET 已失效。
3. 平台 A 充值订单的日期时间字符串和毫秒时间戳均可被上游接受。
4. 平台 B 报表接口实测支持 `pageSize=500`，没有必要仅因旧文档样例为 50 而缩小。
5. 平台 A 登录 IP/设备返回不含单条 `loginTime`，无法精确按最近登录时间排序；这属于上游字段限制，应在产品文案中如实表达。

### 6.4 推荐修改顺序

1. 先修平台 A 充值历史账号过滤，并修复平台 B 代理字段。
2. 再统一上游业务失败识别，随后收紧两个加款接口的成功判定。
3. 修复平台 A 提款时间参数和 `checkUser` 失败语义。
4. 完善 Token 恢复、双后台健康检查与平台 B 详情降级标记。
5. 最后处理限流隔离、持久化幂等、WS Token 权限和统一响应格式。
