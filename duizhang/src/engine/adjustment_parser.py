"""后台备注语义解析 + 总汇调账模块。

扫描「后台」Sheet 每个钱包明细行的【备注】列，识别调账语义：
  1. 下发/内充 + U数 + 汇率 → 计算人民币，累加到总汇【资金转出】(E列)
  2. 修改金额/调账 → 累加到总汇【人工充值】(H列)

所有修改直接针对总汇单元格 .value 赋值，不动公式。
"""

import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

logger = logging.getLogger(__name__)


def parse_backend_notes(work_file: str) -> Dict[str, Dict[str, float]]:
    """扫描后台所有钱包的备注列，提取调账金额。

    Args:
        work_file: 工作文件路径（含后台+总汇）

    Returns:
        {钱包名: {"transfer_out": 累加金额, "charge_manual": 累加金额}}
    """
    if not Path(work_file).exists():
        logger.warning(f"工作文件不存在: {work_file}")
        return {}

    wb = load_workbook(work_file, data_only=True)
    ws = wb["后台"]

    # {钱包名: {transfer_out: 0, charge_manual: 0}}
    adjustments: Dict[str, Dict[str, float]] = {}

    max_col = ws.max_column
    col = 1
    while col <= max_col:
        wallet_name = ws.cell(2, col).value  # 钱包名在 Row 2
        if not wallet_name:
            col += 1
            continue
        wallet_name = str(wallet_name).strip()
        if not wallet_name or wallet_name in ("0", "#VALUE!", "#REF!"):
            col += 1
            continue

        # 扫描该钱包所有行的备注列 (column offset 8 = I列)
        transfer_out = 0.0
        charge_manual = 0.0

        for r in range(7, min(ws.max_row, 1000)):
            note = ws.cell(r, col + 8).value  # I列=备注
            if not note:
                continue
            note_str = str(note).strip()
            if not note_str:
                continue

            # ── 规则1: 下发/内充 + U数 + 汇率 → 资金转出 ──
            t_out = _parse_transfer_note(note_str)
            if t_out > 0:
                transfer_out += t_out
                logger.debug(f"  {wallet_name} Row{r}: 下发/内充 {t_out:,.0f} CNY ← '{note_str[:60]}'")
                continue

            # ── 规则2: 修改金额/调账 → 人工充值 ──
            c_man = _parse_adjust_note(note_str)
            if c_man > 0:
                charge_manual += c_man
                logger.debug(f"  {wallet_name} Row{r}: 修改/调账 {c_man:,.0f} ← '{note_str[:60]}'")
                continue

        if transfer_out != 0 or charge_manual != 0:
            adjustments[wallet_name] = {
                "transfer_out": transfer_out,
                "charge_manual": charge_manual,
            }

        col += 10  # 下一钱包列组

    wb.close()

    if adjustments:
        total_to = sum(v["transfer_out"] for v in adjustments.values())
        total_cm = sum(v["charge_manual"] for v in adjustments.values())
        logger.info(f"备注解析: {len(adjustments)}个钱包, 转出={total_to:,.0f}, 人工={total_cm:,.0f}")

    return adjustments


def apply_adjustments(work_file: str, adjustments: Dict[str, Dict[str, float]]) -> int:
    """将调账金额应用到总汇 Sheet 的对应钱包行。

    动态查找区块1表头，按帐户名匹配钱包，累加到资金转出/人工充值列。

    Returns:
        修改的钱包数
    """
    if not adjustments:
        return 0

    wb = load_workbook(work_file)
    ws = wb["总汇"]

    # ── 动态找区块1列号 ──
    col_account = None      # C=帐户名
    col_transfer_out = None  # I=资金转出
    col_charge_manual = None # H=人工充值

    for r in range(1, 10):
        for c in range(1, 20):
            val = str(ws.cell(r, c).value or "")
            if "帐户名" in val:
                col_account = c
            if val == "资金转出":
                col_transfer_out = c
            if val == "人工充值":
                col_charge_manual = c
        if col_account and col_transfer_out and col_charge_manual:
            break

    if not all([col_account, col_transfer_out, col_charge_manual]):
        logger.warning("总汇: 找不到区块1表头列")
        wb.close()
        return 0

    count = 0
    max_row = ws.max_row or 150

    for r in range(5, max_row + 1):
        account = str(ws.cell(r, col_account).value or "").strip()
        if not account or account == "*" or account.startswith("="):
            continue
        if "人民币昨日余额" in account or "USDT" in account.upper():
            break  # 进入区块2，停止

        adj = adjustments.get(account)
        if not adj:
            continue

        # 资金转出 = 原值 + 调账增量
        if adj["transfer_out"] != 0:
            old_val = _safe_float(ws.cell(r, col_transfer_out).value)
            ws.cell(r, col_transfer_out, old_val + adj["transfer_out"])

        # 人工充值 = 原值 + 调账增量
        if adj["charge_manual"] != 0:
            old_val = _safe_float(ws.cell(r, col_charge_manual).value)
            ws.cell(r, col_charge_manual, old_val + adj["charge_manual"])

        count += 1

    wb.save(work_file)
    wb.close()
    logger.info(f"调账应用: {count}个钱包 → {work_file}")
    return count


# ── 正则解析函数 ──

def _parse_transfer_note(note: str) -> float:
    """解析下发/内充备注，返回人民币金额。

    示例:
      "下发5000u 汇率7" → 35000
      "内充10000 u 汇率 6.9" → 69000
      "转 USDT9 下发8000 u 6.9" → 55200
    """
    if not note:
        return 0.0
    # 必须含有关键词
    if not re.search(r'下发|内充', note):
        return 0.0
    if not re.search(r'[uU]', note):
        return 0.0

    # 提取 U 数: 数字 + 可选空格 + u/U
    u_match = re.search(r'([\d,.]+)\s*[uU]', note)
    if not u_match:
        return 0.0
    u_amount = float(u_match.group(1).replace(",", ""))

    # 提取汇率: "汇率"后数字 或 U数后的数字
    rate = 0.0
    rate_match = re.search(r'汇率\s*([\d.]+)', note)
    if rate_match:
        rate = float(rate_match.group(1))
    else:
        # 尝试 U数后面的小数
        after_u = note[u_match.end():].strip()
        rate_match2 = re.search(r'([\d.]+)', after_u)
        if rate_match2:
            rate = float(rate_match2.group(1))

    if rate <= 0:
        logger.debug(f"无法提取汇率: '{note[:80]}'")
        return 0.0

    cny = round(u_amount * rate, 2)
    return cny


def _parse_adjust_note(note: str) -> float:
    """解析修改金额/调账备注，返回调整金额。

    示例:
      "修改金额 500" → 500
      "调账 +300 手续费1.3" → 300
    """
    if not note:
        return 0.0
    if not re.search(r'修改金额|调账|人工加款|调整', note):
        return 0.0

    # 提取第一个数字
    num_match = re.search(r'([\d,.]+)', note)
    if not num_match:
        return 0.0
    return float(num_match.group(1).replace(",", ""))


def _safe_float(v) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (ValueError, TypeError):
        return 0.0
