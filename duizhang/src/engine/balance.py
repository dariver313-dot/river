"""余额结转引擎。

每天做账时，先从前一天的对账文件中读取各钱包的期末余额，
作为今天的期初余额。然后：
  期初余额 + 今日充值(线上+群码) - 今日提现 = 期末余额
"""

import logging
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, Optional

from openpyxl import load_workbook

logger = logging.getLogger(__name__)


class BalanceTracker:
    """读取昨日期末余额，计算今日余额。

    流程：
    1. 找到昨天的对账文件
    2. 从文件的 总汇 sheet 中读取各账户的期末余额
    3. 结合今日充值/提现，计算各账户今日期末余额
    """

    def __init__(self, platform_config: dict):
        cells = platform_config["template_cells"]
        self.sheet_name = cells.get("sheet", "总汇")
        self.account_col = cells["account_col"]   # B列: 账户名
        self.account_rows = cells["account_rows"]   # [4, 34]: 账户名行范围
        self.balance_col = cells.get("balance_col", None)  # 期末余额列（若有）
        self.output_dir = platform_config.get("_global", {}).get("output", {}).get("dir", "data/output")
        self.platform_name = platform_config["name"]

    def load_yesterday_balances(self) -> Dict[str, float]:
        """从昨天的对账文件中读取各账户的期末余额。

        Returns:
            {账户名: 期末余额}，如果没有昨天的文件则返回空字典
        """
        yesterday = date.today() - timedelta(days=1)
        file_path = self._find_yesterday_file(yesterday)

        if not file_path:
            logger.info(f"{self.platform_name}: 未找到昨日对账文件，期初余额全部为0")
            return {}

        logger.info(f"{self.platform_name}: 读取昨日期末余额: {file_path}")

        try:
            wb = load_workbook(file_path, data_only=True)
            ws = wb[self.sheet_name]

            balances = {}
            for row_idx in range(self.account_rows[0], self.account_rows[1] + 1):
                account_name = ws[f"{self.account_col}{row_idx}"].value
                if not account_name:
                    continue

                # 期末余额 = 期初 + 充值(线上+群码) - 提现
                # 如果模版有独立的期末余额列就读取它，否则从各列推算
                if self.balance_col:
                    balance = ws[f"{self.balance_col}{row_idx}"].value
                else:
                    # 从各分散列推算期末余额
                    # 这里假设各列值和 man.py 写入的结构一致
                    balance = self._calculate_balance_from_row(ws, row_idx)

                if balance is not None:
                    balances[str(account_name)] = float(balance)

            logger.info(
                f"{self.platform_name}: 读取到 {len(balances)} 个账户余额, "
                f"总额 {sum(balances.values()):,.2f}"
            )
            return balances

        except Exception as e:
            logger.warning(f"{self.platform_name}: 读取昨日文件失败: {e}")
            return {}

    def calculate_today_balances(
        self,
        opening_balances: Dict[str, float],
        withdrawal_result: Dict[str, float],
        manual_charge_result: Dict[str, float],
    ) -> Dict[str, Dict[str, float]]:
        """计算今日各账户的完整余额变动。

        Args:
            opening_balances: 昨日期末余额 = 今日期初 {账户名: 金额}
            withdrawal_result: 今日提现 {账户名: 金额}
            manual_charge_result: 今日群码充值 {群码名: 金额}

        Returns:
            {账户名: {"期初": x, "充值": y, "提现": z, "期末": balance}}
        """
        # 收集所有涉及的账户名
        all_accounts = set(opening_balances.keys())
        all_accounts.update(withdrawal_result.keys())
        all_accounts.update(manual_charge_result.keys())

        result = {}
        for account in sorted(all_accounts):
            opening = opening_balances.get(account, 0.0)
            charge_in = manual_charge_result.get(account, 0.0)
            withdraw_out = withdrawal_result.get(account, 0.0)
            closing = opening + charge_in - withdraw_out

            result[account] = {
                "期初余额": opening,
                "充值金额": charge_in,
                "提现金额": withdraw_out,
                "期末余额": closing,
            }

        return result

    def _find_yesterday_file(self, yesterday: date) -> Optional[Path]:
        """查找昨天的对账文件。"""
        date_str = yesterday.strftime("%Y%m%d")
        output_path = Path(self.output_dir)

        if not output_path.exists():
            return None

        # 匹配模式: 平台名_已做账_20260603.xlsx
        patterns = [
            f"{self.platform_name}_已做账_{date_str}.xlsx",
            f"*已做账_{date_str}.xlsx",
        ]

        for pattern in patterns:
            matches = list(output_path.glob(pattern))
            if matches:
                return matches[0]

        return None

    def _calculate_balance_from_row(self, ws, row_idx: int) -> Optional[float]:
        """从模版各列推算期末余额（当没有独立余额列时）。

        假设: H=群码充值, J=提现, 期初需要从其他列读
        如果没有期初列，返回 None（需要模版结构支持）
        """
        # 尝试读 H列(充值) 和 J列(提现)
        h_val = ws[f"H{row_idx}"].value or 0
        j_val = ws[f"J{row_idx}"].value or 0
        return float(h_val) - float(j_val)
