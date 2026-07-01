# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

澳门娱乐城三平台自动做账系统 — Python tkinter GUI，支持天游/澳博国际/澳门娱乐城的一键对账。

核心功能：读取后台 sheet 各钱包每日汇总 → 映射到总汇账户行 → 计算余额 → 写入 Excel。

## 开发命令

```bash
pip install pandas openpyxl requests PyYAML python-dotenv
python main.py
```

## 项目结构

```
duizhang/
├── config/
│   ├── platforms.yaml      # ★ 三平台完整配置（API字段映射、后台钱包→总汇账户映射、模版坐标）
│   └── settings.yaml        # 全局设置
├── src/
│   ├── engine/
│   │   ├── reconciler.py    # 对账编排器（编排后台读取→映射→余额计算）
│   │   ├── backend_reader.py# 后台 sheet 读取器（逐列扫描钱包，读Row4每日汇总）
│   │   ├── balance.py       # 余额结转（昨日期末→今日期初）
│   │   ├── matcher.py       # 通用匹配器
│   │   └── charge.py / withdrawal.py  # 旧引擎模块（man.py兼容）
│   ├── connectors/
│   │   ├── api_connector.py # 通用API连接器（就绪后替代backend_reader）
│   │   └── excel_fallback.py
│   ├── writers/
│   │   └── excel_writer.py  # 写入模版：F-M列 + Row3合计行
│   ├── config_loader.py     # YAML + ${ENV_VAR} 替换
│   └── logger.py            # 文件轮转 + GUI实时显示
├── excel/                   # ★ 原始数据文件目录
│   ├── 2026天游.xlsx         # 天游模版（总汇全零）
│   ├── 2026天游6.1.xlsx      # 天游6.1数据（后台+总汇）
│   ├── 2026天游6.2.xlsx      # 天游6.2数据
│   ├── 2026澳博国际.xlsx     # 澳博国际模版
│   ├── 2026澳博国际6.1.xlsx  # 澳博国际6.1数据
│   ├── 2026澳博国际6.2.xlsx  # 澳博国际6.2数据
│   ├── 2026澳门娱乐城.xlsx   # 澳门娱乐城模版
│   ├── 2026澳门娱乐城6.1.xlsx# 澳门娱乐城6.1数据
│   └── 2026澳门娱乐城6.2.xlsx# 澳门娱乐城6.2数据
├── data/output/             # 生成的做账文件
├── main.py                  # GUI入口
├── main_old.py              # 旧版 man.py 备份
└── tests/test_engine.py     # 旧引擎单元测试
```

## 真实数据结构（来自Excel分析）

### 总汇 Sheet（三平台一致）
```
Row 2:  {平台}出入款报表
Row 3:  合计行（各列汇总）
Row 4:  表头
Row 5+: 账户明细行

列: B=编号 C=帐户名 D=登入名
    F=会员充值  G=未提交  H=人工充值  I=资金转出
    J=会员取款  K=手续费  L=余额  M=昨日余额  N=备注
```

### 余额公式（已验证26+账户全部正确）
```
L(余额) = M(昨日余额) + F + G + H - I - J - K
```

### 后台 Sheet（每个钱包占10列）
```
Row 1: 分组编号   Row 2: 钱包名称   Row 3: 费率说明
Row 4: ★ 每日汇总（核心数据行）
Row 5: 表头        Row 6+: 逐笔交易明细

每10列块内偏移:
  0=用户名  1=会员充值→F  2=未提交→G  3=人工充值→H
  4=资金转出→I  5=会员取款→J  6=手续费→K  7=余额→L
  8=备注  9=预留
```

### 日终余额结转（已验证6.1→6.2完全一致）
```
今日L列(余额) = 明日M列(昨日余额)
```

## 架构要点

### 数据流
```
用户选择数据文件（含后台sheet）
→ BackendReader 逐列扫描所有钱包Row4汇总
→ 模糊匹配钱包名→总汇账户名（wallet_account_map + 关键词匹配）
→ 汇总各账户的F/G/H/I/J/K
→ 计算 L = M + F + G + H - I - J - K
→ ExcelWriter 写入模版，生成输出文件
```

### 配置驱动
- `platforms.yaml` 中 `wallet_account_map` 处理后台钱包名与总汇账户名的差异
- 模糊匹配自动处理大部分名称变体，仅特殊情况需显式配置
- 新平台：在 platforms.yaml 添加配置块即可

### 引擎已验证
- 澳博国际 6.1: 33个钱包 → 31个总汇账户，全部数据100%吻合
- 澳门娱乐城 6.1: 全部数据100%吻合
- 天游 6.1: 修复3个钱包名映射后100%吻合

## 待接入
- **API接口**：APIConnector 就绪后，替换 BackendReader 的数据来源
- **群组聊天记录**：当前所有数据（含群码）均已在后台sheet中，暂不需要单独处理
