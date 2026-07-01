"""后台 Sheet 读取器。

从 Excel 后台 sheet 中读取各钱包的每日汇总数据。
当 API 就绪后，APIConnector 将替代此模块 — 输出相同的 DataFrame 格式。

后台 Sheet 结构 (每个钱包占10列):
  Row 1: 分组编号
  Row 2: 钱包名称
  Row 3: 费率说明
  Row 4: ★ 每日汇总 (核心数据行)
  Row 5: 表头
  Row 6+: 逐笔交易明细

每个钱包10列的内部偏移:
  0=总计  1=会员充值→F  2=未提交→G  3=人工充值→H
  4=资金转出→I  5=会员取款→J  6=手续费→K  7=余额→L
  8=备注  9=预留
"""

import logging
from pathlib import Path
from typing import Dict, List, Optional

import openpyxl
import pandas as pd

logger = logging.getLogger(__name__)


class BackendReader:
    """读取后台 sheet，提取各钱包每日汇总。

    API 就绪后将被 APIConnector 替代 — 两者输出统一格式。
    """

    def __init__(self, platform_config: dict):
        backend_cfg = platform_config.get("backend_sheet", {})
        self.sheet_name = backend_cfg.get("sheet", "后台")
        self.wallet_row = backend_cfg.get("wallet_header_row", 2)
        self.summary_row = backend_cfg.get("summary_row", 4)
        self.columns_per_wallet = backend_cfg.get("columns_per_wallet", 10)
        self.offsets = backend_cfg.get("col_offsets", {})
        self.wallet_map = platform_config.get("wallet_account_map", {})

    def read_summaries(self, file_path: str) -> Dict[str, Dict[str, float]]:
        """读取后台 sheet，返回 {钱包名: {charge_online, withdrawal, fee, ...}}

        Args:
            file_path: 包含后台 sheet 的 Excel 文件路径

        Returns:
            {钱包名: {"charge_online": xxx, "unsubmitted": xxx, ...}}
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"文件不存在: {file_path}")

        wb = openpyxl.load_workbook(file_path, data_only=True)
        if self.sheet_name not in wb.sheetnames:
            wb.close()
            logger.warning(f"文件 {file_path} 中无 '{self.sheet_name}' sheet")
            return {}

        ws = wb[self.sheet_name]
        max_col = ws.max_column
        logger.info(f"读取后台: {file_path}, cols=1..{max_col}")

        result = {}
        col = 1
        while col <= max_col:
            wallet_name = ws.cell(self.wallet_row, col).value
            if not wallet_name:
                col += 1  # 逐列扫描，不依赖固定间隔
                continue

            wallet_name = str(wallet_name).strip()
            if not wallet_name or wallet_name in ("0", "#VALUE!", "#REF!"):
                col += 1
                continue

            # 读取该钱包的每日汇总行（基于固定的10列块内偏移）
            summary = {
                "charge_online": self._safe_float(ws, self.summary_row, col + self.offsets.get("charge_online", 1)),
                "unsubmitted": self._safe_float(ws, self.summary_row, col + self.offsets.get("unsubmitted", 2)),
                "charge_manual": self._safe_float(ws, self.summary_row, col + self.offsets.get("charge_manual", 3)),
                "transfer_out": self._safe_float(ws, self.summary_row, col + self.offsets.get("transfer_out", 4)),
                "withdrawal": self._safe_float(ws, self.summary_row, col + self.offsets.get("withdrawal", 5)),
                "fee": self._safe_float(ws, self.summary_row, col + self.offsets.get("fee", 6)),
                "balance": self._safe_float(ws, self.summary_row, col + self.offsets.get("balance", 7)),
            }

            # 跳过全零钱包
            if any(v != 0 for v in summary.values()):
                result[wallet_name] = summary
                logger.debug(f"  钱包 '{wallet_name}': F={summary['charge_online']:,.0f} "
                           f"H={summary['charge_manual']:,.0f} J={summary['withdrawal']:,.0f} "
                           f"K={summary['fee']:,.0f} L={summary['balance']:,.0f}")

            col += self.columns_per_wallet  # 跳到下一个钱包块

        wb.close()
        logger.info(f"后台读取完成: {len(result)} 个非零钱包")
        return result

    @staticmethod
    def _safe_float(ws, row, col) -> float:
        """安全读取数值，None → 0.0"""
        v = ws.cell(row, col).value
        try:
            return float(v) if v is not None else 0.0
        except (ValueError, TypeError):
            return 0.0
