"""充值对账处理器。

从 man.py 的充值处理逻辑抽取：
1. 线上充值：筛选"线上充值转入" → 汇总金额
2. 人工群码充值：筛选"手动微信扫码" → 按操作员匹配群码 → 汇总
"""

import logging
from typing import Dict

import pandas as pd

from .matcher import Matcher

logger = logging.getLogger(__name__)


class ChargeProcessor:
    """处理充值数据：线上充值汇总 + 群码充值匹配汇总。"""

    def __init__(self, platform_config: dict):
        filters = platform_config["transaction_filters"]
        self.amount_field = filters["amount_field"]

        # 线上充值筛选条件
        self.online_type_field = filters["charge_online_type_field"]
        self.online_type_value = filters["charge_online_type_value"]

        # 人工群码充值筛选条件
        self.manual_type_field = filters["charge_manual_type_field"]
        self.manual_type_value = filters["charge_manual_type_value"]
        self.manual_group_field = filters["manual_group_field"]

        # 群码操作员 → 群码账户名
        self.group_mappings = platform_config["group_code_mappings"]

    def process_online(self, df: pd.DataFrame) -> float:
        """处理线上充值：筛选 → 汇总金额。

        Args:
            df: 标准化后的充值 DataFrame

        Returns:
            线上充值总金额
        """
        if df.empty:
            logger.warning("充值数据为空，线上充值返回 0")
            return 0.0

        mask = df[self.online_type_field] == self.online_type_value
        online_df = df[mask]

        if online_df.empty:
            logger.info("没有线上充值记录")
            return 0.0

        total = online_df[self.amount_field].sum()
        logger.info(f"线上充值: {len(online_df)} 条, 总金额 {total:,.2f}")
        return total

    def process_manual(self, df: pd.DataFrame) -> Dict[str, float]:
        """处理人工群码充值：筛选 → 按操作员分组 → 匹配群码 → 汇总。

        Args:
            df: 标准化后的充值 DataFrame

        Returns:
            {群码账户名: 总金额}，如 {"如意群码": 50000.0}
        """
        result: Dict[str, float] = {}

        if df.empty:
            logger.warning("充值数据为空，群码充值返回空")
            return result

        mask = df[self.manual_type_field] == self.manual_type_value
        manual_df = df[mask]

        if manual_df.empty:
            logger.info("没有人工群码充值记录")
            return result

        logger.info(f"群码充值: {len(manual_df)} 条")

        # 按操作员备注分组汇总，然后匹配群码名
        grouped = manual_df.groupby(self.manual_group_field)[self.amount_field].sum()

        for operator_name, amount in grouped.items():
            matched = Matcher.match_exact(operator_name, self.group_mappings)
            if matched:
                result[matched] = result.get(matched, 0.0) + amount
                logger.debug(f"  群码匹配: {operator_name} → {matched}: {amount:,.2f}")
            else:
                logger.warning(f"  未匹配群码: operator='{operator_name}', amount={amount:,.2f}")

        total = sum(result.values())
        logger.info(f"群码充值汇总: {len(result)} 个群码, 总金额 {total:,.2f}")
        return result
