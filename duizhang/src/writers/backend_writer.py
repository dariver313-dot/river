"""双表写入器 v3 — AI 驱动。

接收统一的写表指令 [{sheet, wallet, description, entries: [{col, value}], note}]，
机械执行：校验 → 找列 → 写入 → 更新余额。
不再硬编码 type→列映射。
"""

import logging
import os
from typing import Dict, List, Optional

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

logger = logging.getLogger(__name__)

# 列字母→offset 映射
BACKEND_COL_MAP = {c: i for i, c in enumerate("ABCDEFGHI")}   # A=0, B=1, ...
USDT_COL_MAP = {c: i for i, c in enumerate("NOPQRSTUVWXY")}    # N=0, O=1, ...


class BackendWriter:
    """纯执行器：接收 AI 写表指令，写入后台+USDT 双表。"""

    def __init__(self, platform_config: dict, output_dir: str = "data/output"):
        self.config = platform_config
        self.platform_name = platform_config["name"]
        self.template_path = platform_config["template"]
        self.output_dir = output_dir

        backend_cfg = platform_config.get("backend_sheet", {})
        self.sheet_name = backend_cfg.get("sheet", "后台")
        self.wallet_row = backend_cfg.get("wallet_header_row", 2)
        self.columns_per_wallet = backend_cfg.get("columns_per_wallet", 10)
        self.usdt_sheet_name = "USDT"
        self.usdt_columns_per_wallet = 13

    def build_daily_file(
        self,
        write_instructions: List[dict] = None,
        target_date: str = "",
        wallet_cols: dict = None,
        usdt_wallet_cols: dict = None,
    ) -> str:
        """接收写表指令，一键生成当日工作文件。

        Args:
            write_instructions: 写表指令列表
            target_date: YYYYMMDD
            wallet_cols: 预扫描 {后台钱包名: 起始列}
            usdt_wallet_cols: 预扫描 {USDT钱包名: 起始列}

        Returns:
            输出文件路径
        """
        write_instructions = write_instructions or []
        wallet_cols = wallet_cols or {}
        usdt_wallet_cols = usdt_wallet_cols or {}

        if not os.path.exists(self.template_path):
            raise FileNotFoundError(f"模板不存在: {self.template_path}")

        wb = load_workbook(self.template_path)
        ws = wb[self.sheet_name]
        ws_usdt = wb[self.usdt_sheet_name] if self.usdt_sheet_name in wb.sheetnames else None

        # ── 初始化 ──
        # 后台
        wallet_next_row = {}
        for wname, wcol in wallet_cols.items():
            wallet_next_row[wname] = self._find_next_row(ws, wcol)
        # USDT
        usdt_next_row = {}
        if ws_usdt:
            for wname, ucol in usdt_wallet_cols.items():
                usdt_next_row[wname] = self._find_next_row(ws_usdt, ucol)

        logger.info(f"写入: {len(write_instructions)}条指令, 后台{len(wallet_cols)}钱包, USDT{len(usdt_wallet_cols)}钱包")

        # 安全写入：表头行(Row≤11)遇到合并单元格跳过；数据行自动拆分
        def _safe_write(sheet, row, col, value):
            if value is None:
                return
            try:
                c = sheet.cell(row, col)
                c.value = value
            except AttributeError:
                # MergedCell: 表头区域不破坏，只跳过
                if row <= 11:
                    return
                # 数据行：拆分该合并区域后重试
                for mr in list(sheet.merged_cells.ranges):
                    if mr.min_row <= row <= mr.max_row and mr.min_col <= col <= mr.max_col:
                        sheet.unmerge_cells(str(mr))
                        break
                try:
                    sheet.cell(row, col, value)
                except AttributeError:
                    pass  # 实在写不了就跳过

        # ── 逐条执行写表指令 ──
        for inst in write_instructions:
            sheet = inst.get("sheet", "")
            wallet = inst.get("wallet", "")
            desc = str(inst.get("description", ""))[:50]
            entries = inst.get("entries", [])
            note = str(inst.get("note", ""))[:80]

            if sheet == "后台":
                wcol = wallet_cols.get(wallet)
                if not wcol:
                    continue

                row = wallet_next_row[wallet]
                if desc:
                    _safe_write(ws, row, wcol + 0, desc)  # A=描述

                # 写入各列，累加余额变动
                delta = 0.0
                for e in entries:
                    col_letter = e["col"]
                    value = e["value"]
                    offset = BACKEND_COL_MAP.get(col_letter)
                    if offset is None:
                        continue
                    _safe_write(ws, row, wcol + offset, value)
                    # 计算余额影响: B/C/D加, E/F/G减
                    if col_letter in "BCD":
                        delta += value
                    elif col_letter in "EFG":
                        delta -= value

                if note:
                    _safe_write(ws, row, wcol + 8, note)  # I=备注

                wallet_next_row[wallet] = row + 1

            elif sheet == "USDT" and ws_usdt:
                ucol = usdt_wallet_cols.get(wallet)
                if not ucol:
                    continue

                row = usdt_next_row[wallet]
                if desc:
                    _safe_write(ws_usdt, row, ucol +0, desc)  # N=描述

                cny_delta = 0.0
                usdt_delta = 0.0
                for e in entries:
                    col_letter = e["col"]
                    value = e["value"]
                    offset = USDT_COL_MAP.get(col_letter)
                    if offset is None:
                        continue
                    _safe_write(ws_usdt, row, ucol +offset, value)
                    # O/P/Q/R加, S/T/U减
                    if col_letter in "OPQR":
                        cny_delta += value
                    elif col_letter in "STU":
                        cny_delta -= value
                    if col_letter == "P":
                        usdt_delta += value
                    elif col_letter == "S":
                        usdt_delta -= value

                if note:
                    _safe_write(ws_usdt, row, ucol +11, note)  # Y=备注

                usdt_next_row[wallet] = row + 1

        # ★ 不写 Row6 — 模板公式 =总汇!M5/=总汇!M66 自动引用期初
        # ★ 不写余额列 — 模板公式 =ROUND(H6+B7+...) 自动计算

        # ── 保存 ──
        os.makedirs(self.output_dir, exist_ok=True)
        filename = f"{self.platform_name}_工作文件_{target_date}.xlsx"
        output_path = os.path.join(self.output_dir, filename)
        wb.save(output_path)
        logger.info(f"双表写入完成: {output_path}")
        return output_path

    def _find_next_row(self, ws, wallet_col: int) -> int:
        """找下一空行（限500行，避免USDT百万行扫描）。"""
        MIN_DATA_ROW = 10
        MAX_SCAN = 500
        last_used = MIN_DATA_ROW - 1
        actual_max = min(ws.max_row, MAX_SCAN)
        check_offsets = [0, 1, 2, 3, 4, 5, 6, 8]

        for r in range(MIN_DATA_ROW, actual_max + 1):
            for offset in check_offsets:
                v = ws.cell(r, wallet_col + offset).value
                if v is not None and str(v).strip() not in ("", "0", "0.0", "0.00"):
                    last_used = r
                    break
        return last_used + 1

    # ── 辅助：将充提表交易转为写表指令 ──

    @staticmethod
    def deposit_to_instructions(deposit_transactions: List[dict],
                                 manual_deposit_transactions: List[dict] = None) -> List[dict]:
        """充值交易 → 写表指令。"""
        instructions = []
        for txn in (deposit_transactions or []):
            wallet = str(txn.get("wallet", "") or "")
            if not wallet or wallet.lower() == "nan":
                continue
            username = str(txn.get("username", ""))[:50]
            amount = float(txn.get("amount", 0) or 0)
            if not amount:
                continue
            txn_type = str(txn.get("type", "") or "")
            note = str(txn.get("note", ""))[:60]

            if txn_type == "charge_manual":
                col = "D"  # 人工充值
            else:
                col = "B"  # 会员充值

            instructions.append({
                "sheet": "后台",
                "wallet": wallet,
                "description": username,
                "entries": [{"col": col, "value": amount}],
                "note": note,
            })

        for txn in (manual_deposit_transactions or []):
            wallet = str(txn.get("wallet", "") or "")
            if not wallet or wallet.lower() == "nan":
                continue
            username = str(txn.get("username", ""))[:50]
            amount = float(txn.get("amount", 0) or 0)
            if not amount:
                continue
            note = str(txn.get("note", ""))[:60]
            instructions.append({
                "sheet": "后台",
                "wallet": wallet,
                "description": username,
                "entries": [{"col": "D", "value": amount}],  # 人工充值
                "note": note,
            })

        return instructions

    @staticmethod
    def withdraw_to_instructions(withdraw_transactions: List[dict]) -> List[dict]:
        """提现交易 → 写表指令。"""
        instructions = []
        for txn in (withdraw_transactions or []):
            wallet = str(txn.get("wallet", "") or "")
            if not wallet or wallet.lower() == "nan":
                continue
            username = str(txn.get("username", ""))[:50]
            amount = float(txn.get("amount", 0) or 0)
            fee = float(txn.get("fee", 0) or 0)
            if not amount and not fee:
                continue
            note = str(txn.get("note", ""))[:60]

            entries = []
            if amount:
                entries.append({"col": "F", "value": amount})  # 会员取款
            if fee:
                entries.append({"col": "G", "value": fee})     # 手续费

            instructions.append({
                "sheet": "后台",
                "wallet": wallet,
                "description": username,
                "entries": entries,
                "note": note,
            })
        return instructions
