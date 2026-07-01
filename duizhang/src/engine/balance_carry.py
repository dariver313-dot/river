"""余额结转模块。

从数据源文件的总汇 Sheet 读取各账户/钱包的余额，
精准写入模板文件的「昨日余额」列，不破坏任何公式和格式。

两个区块:
  区块1 (人民币钱包): Row5+  C列=帐户名 → M列=昨日余额
  区块2 (USDT/四方):   Row64+ B列=编号   → M列=人民币昨日余额, N列=USDT昨日余额
"""

import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

logger = logging.getLogger(__name__)


def carry_balances(
    source_file: str,
    template_file: str,
    output_file: str,
    sheet_name: str = "总汇",
) -> str:
    """执行余额结转：数据源余额 → 模板昨日余额列。

    Args:
        source_file: 数据源文件路径（昨日做账输出）
        template_file: 空白模板文件路径
        output_file: 输出文件路径
        sheet_name: Sheet名，默认"总汇"

    Returns:
        输出文件路径
    """
    if not Path(source_file).exists():
        raise FileNotFoundError(f"数据源不存在: {source_file}")
    if not Path(template_file).exists():
        raise FileNotFoundError(f"模板不存在: {template_file}")

    # ── 1. 从数据源提取余额 ──
    block1_data, block2_data = _extract_balances(source_file, sheet_name)
    logger.info(f"提取余额: 区块1={len(block1_data)}个, 区块2={len(block2_data)}个")

    # ── 2. 写入模板 ──
    wb = load_workbook(template_file)
    ws = wb[sheet_name]

    # 区块1: 人民币钱包
    count1 = _write_block1(ws, block1_data)
    # 区块2: USDT/四方支付
    count2 = _write_block2(ws, block2_data)

    wb.save(output_file)
    wb.close()
    logger.info(f"余额结转完成: 区块1={count1}个, 区块2={count2}个 → {output_file}")
    return output_file


def _extract_balances(file_path: str, sheet_name: str) -> Tuple[dict, dict]:
    """从数据源提取两个区块的余额数据。

    Returns:
        (block1_dict, block2_dict)
        block1: {帐户名: 余额}
        block2: {编号: (人民币余额, USDT余额)}
    """
    wb = load_workbook(file_path, data_only=True, read_only=True)
    ws = wb[sheet_name]

    block1 = {}  # {帐户名: 余额值}
    block2 = {}  # {编号: (人民币余额, USDT余额)}

    max_row = ws.max_row or 150
    max_col = ws.max_column or 20

    # 先读取整个 sheet 到内存（read_only 需一次性迭代）
    rows_data = list(ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col, values_only=False))

    # ── 找到区块1表头 (包含"帐户名"或"昨日余额"的行) ──
    block1_header_row = None
    block1_col_account = None   # C列=帐户名
    block1_col_balance = None   # L列=余额

    for r_idx, row in enumerate(rows_data):
        cells_text = [str(c.value) if c.value else "" for c in row]
        row_num = r_idx + 1
        # 表头特征: 同时有"帐户名"和"昨日余额"
        has_account = any("帐户名" in t for t in cells_text)
        has_yesterday = any("昨日余额" in t for t in cells_text)
        if has_account and has_yesterday:
            block1_header_row = row_num
            # 动态找列号
            for c_idx, cell in enumerate(row):
                col_num = c_idx + 1
                val = str(cell.value or "")
                if "帐户名" in val:
                    block1_col_account = col_num
                if val == "昨日余额":  # 精确匹配，避免"人民币昨日余额"干扰
                    block1_col_balance = col_num
            break

    # ── 找到区块2表头 (包含"人民币昨日余额"和"USDT昨日余额") ──
    block2_header_row = None
    block2_col_id = None       # B列=编号
    block2_col_cny_bal = None  # L列=人民币余额 (源表)
    block2_col_usdt_bal = None # N列=USDT余额 (源表，或另外的列)

    for r_idx, row in enumerate(rows_data):
        cells_text = [str(c.value) if c.value else "" for c in row]
        row_num = r_idx + 1
        has_cny_yday = any("人民币昨日余额" in t for t in cells_text)
        has_usdt_yday = any("USDT昨日余额" in t for t in cells_text)
        has_id = any("编号" in t for t in cells_text)
        if has_id and has_cny_yday and has_usdt_yday:
            block2_header_row = row_num
            for c_idx, cell in enumerate(row):
                col_num = c_idx + 1
                val = str(cell.value or "")
                if val == "编号":
                    block2_col_id = col_num
                # 在数据源中，"USDT余额"是源余额
                if "USDT余额" in val and "昨日" not in val:
                    block2_col_usdt_bal = col_num
                # 在数据源中，"余额"或"人民币余额"是源人民币余额
                # 注意：区块2中人民币余额在 L 列，但表头可能是"USDT余额"以外的列
                # 实际上 L列=USDT余额, 我们需要找到"人民币余额"列
                if "人民币余额" in val and "昨日" not in val:
                    block2_col_cny_bal = col_num
            break

    # ── 提取区块1数据 ──
    if block1_header_row and block1_col_account and block1_col_balance:
        for r_idx in range(block1_header_row, len(rows_data)):
            row = rows_data[r_idx]
            account = _safe_str(row[block1_col_account - 1].value) if block1_col_account <= len(row) else ""
            if not account or account == "*" or account.startswith("="):
                continue
            # 跳过区块2表头
            if "人民币昨日余额" in account or "USDT昨日余额" in account:
                break
            # 跳过标题行
            if account in ("现有总余额", "总汇", "编号", "帐户名"):
                continue
            balance = _safe_float(row[block1_col_balance - 1].value) if block1_col_balance <= len(row) else 0
            block1[account] = balance

    # ── 提取区块2数据 ──
    if block2_header_row and block2_col_id:
        for r_idx in range(block2_header_row, len(rows_data)):
            row = rows_data[r_idx]
            wid = _safe_str(row[block2_col_id - 1].value) if block2_col_id <= len(row) else ""
            if not wid or wid == "*" or wid.startswith("=") or wid.startswith("SUM"):
                continue
            cny_bal = _safe_float(row[block2_col_cny_bal - 1].value) if block2_col_cny_bal and block2_col_cny_bal <= len(row) else 0
            usdt_bal = _safe_float(row[block2_col_usdt_bal - 1].value) if block2_col_usdt_bal and block2_col_usdt_bal <= len(row) else 0
            # 如果没找到人民币余额列，用 L 列（USDT余额）做 fallback
            if block2_col_cny_bal is None:
                cny_bal = _safe_float(row[block2_col_id].value) if block2_col_id + 1 <= len(row) else 0
            block2[wid] = (cny_bal, usdt_bal)

    wb.close()
    return block1, block2


def _write_block1(ws, data: dict) -> int:
    """写入区块1: 人民币钱包的昨日余额。

    Returns: 成功写入数量
    """
    count = 0
    max_row = ws.max_row or 150

    # 动态找列
    col_account = None
    col_yesterday = None
    for r in range(1, 6):
        for c in range(1, 20):
            val = str(ws.cell(r, c).value or "")
            if "帐户名" in val:
                col_account = c
            if val == "昨日余额":
                col_yesterday = c
        if col_account and col_yesterday:
            break

    if not col_account or not col_yesterday:
        logger.warning("区块1: 找不到帐户名/昨日余额列")
        return 0

    for r in range(5, max_row + 1):
        account = _safe_str(ws.cell(r, col_account).value)
        if not account or account == "*" or account.startswith("="):
            continue
        if "人民币昨日余额" in account or "USDT" in account.upper():
            break
        if account in data:
            _set_cell(ws, r, col_yesterday, data[account])
            count += 1

    return count


def _write_block2(ws, data: dict) -> int:
    """写入区块2: USDT/四方支付的昨日余额。

    Returns: 成功写入数量
    """
    count = 0
    max_row = ws.max_row or 150

    # 区块2表头固定在 Row 65，列位置相对固定
    header_row = 65
    col_id = None          # B=编号
    col_cny_yday = None    # M=人民币昨日余额
    col_usdt_yday = None   # N=USDT昨日余额

    # 从 Row 65 读取表头
    for c in range(1, 20):
        val = str(ws.cell(header_row, c).value or "")
        if val == "编号":
            col_id = c
        if "人民币昨日余额" in val:
            col_cny_yday = c
        if "USDT昨日余额" in val:
            col_usdt_yday = c

    # 兜底：硬编码列位置
    if not col_id:
        col_id = 2     # B列
    if not col_cny_yday:
        col_cny_yday = 13  # M列
    if not col_usdt_yday:
        col_usdt_yday = 14  # N列

    logger.debug(f"区块2列: id=B{col_id}, CNY昨日=M{col_cny_yday}, USDT昨日=N{col_usdt_yday}")

    for r in range(64, max_row + 1):
        wid = _safe_str(ws.cell(r, col_id).value)
        if not wid or wid == "*" or wid.startswith("="):
            continue
        if wid.startswith("SUM"):
            continue
        if wid in data:
            cny_val, usdt_val = data[wid]
            _set_cell(ws, r, col_cny_yday, cny_val)
            _set_cell(ws, r, col_usdt_yday, usdt_val)
            count += 1

    return count


def _set_cell(ws, row, col, value):
    """安全写入单元格，跳过 MergedCell。"""
    try:
        ws.cell(row, col, value)
    except AttributeError:
        # MergedCell: 只跳过，不破坏模板
        if row <= 11:
            return
        for mr in list(ws.merged_cells.ranges):
            if mr.min_row <= row <= mr.max_row and mr.min_col <= col <= mr.max_col:
                ws.unmerge_cells(str(mr))
                break
        try:
            ws.cell(row, col, value)
        except AttributeError:
            pass


def _safe_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (int, float)):
        return str(v)
    return str(v).strip()


def _safe_float(v) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (ValueError, TypeError):
        return 0.0
