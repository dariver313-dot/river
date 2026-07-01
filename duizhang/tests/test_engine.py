"""验证引擎逻辑：用模拟数据测试对账计算是否正确。

运行: python tests/test_engine.py
"""

import sys
from pathlib import Path

# 加项目根目录到 path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
from src.engine.reconciler import Reconciler
from src.engine.withdrawal import WithdrawalProcessor
from src.engine.charge import ChargeProcessor
from src.engine.matcher import Matcher


def make_platform_config():
    """构造与 man.py 旧逻辑一致的平台配置。"""
    return {
        "name": "测试平台",
        "transaction_filters": {
            "withdrawal_status_field": "status",
            "withdrawal_status_value": "代付成功",
            "charge_online_type_field": "type",
            "charge_online_type_value": "线上充值转入",
            "charge_manual_type_field": "type",
            "charge_manual_type_value": "手动微信扫码",
            "amount_field": "amount",
            "manual_group_field": "operator",
        },
        "channel_mappings": {
            "AB": "AB钱包",
            "CB": "C币钱包",
            "KD": "K豆钱包",
            "JD": "JD钱包",
            "OK": "OK钱包",
            "234": "234钱包",
            "988": "988钱包",
            "365": "365钱包",
        },
        "group_code_mappings": {
            "如意": "如意群码",
            "顺利": "顺利群码",
            "村长": "村长群码",
            "发财": "发财群码",
        },
        "template_cells": {
            "sheet": "总汇",
            "account_col": "B",
            "account_rows": [4, 34],
            "withdrawal_col": "J",
            "withdrawal_total": "J53",
            "online_charge_total": "F52",
            "manual_charge_col": "H",
            "manual_charge_total": "H53",
        },
    }


def test_matcher():
    """测试匹配器。"""
    print("=== 测试 Matcher ===")

    # 关键词匹配
    result = Matcher.match_keyword("AB钱包充值", {"AB": "AB钱包", "CB": "C币钱包"})
    assert result == "AB钱包", f"期望 AB钱包, 实际 {result}"

    result = Matcher.match_keyword("KD提现代付成功", {"KD": "K豆钱包"})
    assert result == "K豆钱包", f"期望 K豆钱包, 实际 {result}"

    result = Matcher.match_keyword("未知渠道", {"AB": "AB钱包"})
    assert result is None, f"期望 None, 实际 {result}"

    # 精确匹配
    result = Matcher.match_exact("如意", {"如意": "如意群码", "村长": "村长群码"})
    assert result == "如意群码", f"期望 如意群码, 实际 {result}"

    result = Matcher.match_exact("未知人", {"如意": "如意群码"})
    assert result is None, f"期望 None, 实际 {result}"

    print("  ✅ Matcher 测试通过")


def test_withdrawal():
    """测试提现处理（模拟 man.py 旧逻辑）。"""
    print("=== 测试 WithdrawalProcessor ===")
    config = make_platform_config()
    processor = WithdrawalProcessor(config)

    # 模拟提现数据
    df = pd.DataFrame({
        "status": ["代付成功", "代付成功", "处理中", "代付成功", "代付成功"],
        "channel": [
            "AB钱包提现",   # → AB钱包
            "KD代付",       # → K豆钱包
            "AB提现",       # 状态不是代付成功，应被过滤
            "CB钱包",       # → C币钱包
            "AB充值到账",   # → AB钱包
        ],
        "amount": [1000.0, 2000.0, 500.0, 3000.0, 4000.0],
    })

    result = processor.process(df)

    # AB钱包: 1000 + 4000 = 5000
    assert result.get("AB钱包") == 5000.0, f"AB钱包期望 5000, 实际 {result.get('AB钱包')}"
    # K豆钱包: 2000
    assert result.get("K豆钱包") == 2000.0, f"K豆钱包期望 2000, 实际 {result.get('K豆钱包')}"
    # C币钱包: 3000
    assert result.get("C币钱包") == 3000.0, f"C币钱包期望 3000, 实际 {result.get('C币钱包')}"
    # 总共3个渠道
    assert len(result) == 3, f"期望3个账户, 实际 {len(result)}"

    print(f"  结果: {result}")
    print("  ✅ WithdrawalProcessor 测试通过")


def test_charge():
    """测试充值处理。"""
    print("=== 测试 ChargeProcessor ===")
    config = make_platform_config()
    processor = ChargeProcessor(config)

    df = pd.DataFrame({
        "type": [
            "线上充值转入", "线上充值转入", "线上充值转入",
            "手动微信扫码", "手动微信扫码", "手动微信扫码",
            "手动微信扫码", "其他类型",
        ],
        "amount": [
            10000.0, 20000.0, 5000.0,      # 线上充值
            3000.0, 5000.0, 2000.0, 7000.0,  # 群码充值
            999.0,                           # 忽略
        ],
        "operator": [
            "", "", "",
            "如意", "顺利", "村长", "如意",   # 群码匹配
            "",
        ],
    })

    # 线上充值
    online_total = processor.process_online(df)
    assert online_total == 35000.0, f"线上充值期望 35000, 实际 {online_total}"
    print(f"  线上充值总额: {online_total:,.2f}")

    # 群码充值
    manual_result = processor.process_manual(df)
    # 如意: 3000 + 7000 = 10000
    assert manual_result.get("如意群码") == 10000.0, f"如意群码期望 10000, 实际 {manual_result.get('如意群码')}"
    # 顺利: 5000
    assert manual_result.get("顺利群码") == 5000.0, f"顺利群码期望 5000, 实际 {manual_result.get('顺利群码')}"
    # 村长: 2000
    assert manual_result.get("村长群码") == 2000.0, f"村长群码期望 2000, 实际 {manual_result.get('村长群码')}"

    print(f"  群码充值结果: {manual_result}")
    print("  ✅ ChargeProcessor 测试通过")


def test_reconciler():
    """测试完整对账流程。"""
    print("=== 测试 Reconciler（完整流程）===")
    config = make_platform_config()
    reconciler = Reconciler(config)

    charge_df = pd.DataFrame({
        "type": ["线上充值转入", "手动微信扫码", "手动微信扫码"],
        "amount": [50000.0, 20000.0, 10000.0],
        "operator": ["", "如意", "村长"],
    })

    withdraw_df = pd.DataFrame({
        "status": ["代付成功", "代付成功", "代付成功"],
        "channel": ["AB提现", "KD钱包代付", "AB充值"],
        "amount": [8000.0, 3000.0, 2000.0],
    })

    result = reconciler.run(charge_df, withdraw_df)

    assert result.online_charge_total == 50000.0
    assert result.withdrawal_total == 13000.0
    assert result.manual_charge_total == 30000.0
    assert len(result.errors) == 0

    print(f"  线上充值: {result.online_charge_total:,.2f}")
    print(f"  提现总额: {result.withdrawal_total:,.2f}")
    print(f"  群码充值: {result.manual_charge_total:,.2f}")
    print(f"  提现明细: {result.withdrawal_accounts}")
    print(f"  群码明细: {result.manual_charge_accounts}")
    print("  ✅ Reconciler 完整流程测试通过")


def test_balance_tracker():
    """测试余额计算逻辑。"""
    print("=== 测试 BalanceTracker ===")
    from src.engine.balance import BalanceTracker

    config = make_platform_config()
    config["_global"] = {"output": {"dir": "data/output"}}
    tracker = BalanceTracker(config)

    # 模拟：昨日期末余额 + 今日充值&提现
    opening = {"AB钱包": 100000.0, "KD钱包": 50000.0, "C币钱包": 30000.0}
    withdrawal = {"AB钱包": 8000.0, "KD钱包": 3000.0}
    manual_charge = {"如意群码": 20000.0}

    # 注意：群码充值写入的是群码账户名，不是钱包名
    # 这里测试基础计算
    balances = tracker.calculate_today_balances(opening, withdrawal, manual_charge)

    # AB钱包: 100000 + 0 - 8000 = 92000
    assert balances["AB钱包"]["期初余额"] == 100000.0
    assert balances["AB钱包"]["提现金额"] == 8000.0
    assert balances["AB钱包"]["期末余额"] == 92000.0

    # KD钱包: 50000 + 0 - 3000 = 47000
    assert balances["KD钱包"]["期末余额"] == 47000.0

    # 如意群码（在manual_charge中，不在opening中）
    assert balances["如意群码"]["期初余额"] == 0.0
    assert balances["如意群码"]["充值金额"] == 20000.0
    assert balances["如意群码"]["期末余额"] == 20000.0

    print(f"  余额计算结果:")
    for account, data in balances.items():
        print(f"    {account}: 期初{data['期初余额']:,.0f} "
              f"+ 充值{data['充值金额']:,.0f} "
              f"- 提现{data['提现金额']:,.0f} "
              f"= 期末{data['期末余额']:,.0f}")
    print("  ✅ BalanceTracker 测试通过")


if __name__ == "__main__":
    test_matcher()
    test_withdrawal()
    test_charge()
    test_reconciler()
    test_balance_tracker()
    print("\n🎉 全部测试通过！引擎逻辑与旧 man.py 一致。")
