"""通用工具函数。"""

import logging

logger = logging.getLogger(__name__)


def safe_write_cell(sheet, row, col, value):
    """安全写入 openpyxl 单元格，遇 MergedCell 自动拆分（表头行跳过）。"""
    if value is None:
        return
    try:
        c = sheet.cell(row, col)
        c.value = value
    except AttributeError:
        if row <= 11:
            return  # 保护表头区域
        for mr in list(sheet.merged_cells.ranges):
            if mr.min_row <= row <= mr.max_row and mr.min_col <= col <= mr.max_col:
                sheet.unmerge_cells(str(mr))
                break
        try:
            sheet.cell(row, col, value)
        except AttributeError:
            pass


def safe_str(v) -> str:
    if v is None: return ""
    if isinstance(v, (int, float)): return str(v)
    return str(v).strip()


def safe_float(v) -> float:
    try: return float(v) if v is not None else 0.0
    except (ValueError, TypeError): return 0.0
