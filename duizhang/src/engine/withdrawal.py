"""提现对账处理器。

从 man.py 的提现处理逻辑抽取：
1. 筛选"代付成功"的提现记录
2. 按操作说明中的关键词匹配钱包渠道
3. 按账户汇总金额
"""

import logging
from typing import Dict

import pandas as pd

from .matcher import Matcher

logger = logging.getLogger(__name__)


class WithdrawalProcessor:
    """处理提现数据：筛选成功的提现 → 匹配渠道 → 汇总。"""

    def __init__(self, platform_config: dict):
        filters = platform_config["transaction_filters"]
        self.status_field = filters["withdrawal_status_field"]
        self.status_value = filters["withdrawal_status_value"]
        self.amount_field = filters["amount_field"]

        channel_cfg = platform_config["channel_mappings"]
        # 用于关键词匹配的字段名（从旧代码看是"操作说明"，映射后为"channel"）
        self.channel_field = "channel"
        self.channel_mappings = channel_cfg

    def process(self, df: pd.DataFrame) -> Dict[str, float]:
        """处理提现数据，返回 {账户名: 总金额}。

        Args:
            df: 标准化后的提现 DataFrame，需包含 status, channel, amount 列

        Returns:
            {账户名: 汇总金额}，如 {"AB钱包": 150000.0, "KD钱包": 80000.0}
        """
        result: Dict[str, float] = {}
        total = 0.0

        if df.empty:
            logger.warning("提现数据为空，跳过处理")
            return result

        # 1. 筛选成功提现
        success_mask = df[self.status_field] == self.status_value
        success_df = df[success_mask]

        if success_df.empty:
            logger.info("没有成功的提现记录")
            return result

        logger.info(f"提现: 共 {len(df)} 条, 成功 {len(success_df)} 条")

        # 2. 逐行匹配渠道并汇总
        for _, row in success_df.iterrows():
            channel_raw = str(row[self.channel_field]) if self.channel_field in row.index else ""
            amount = row[self.amount_field]

            matched = Matcher.match_keyword(channel_raw, self.channel_mappings)
            if matched:
                result[matched] = result.get(matched, 0.0) + amount
                total += amount
            else:
                logger.debug(f"未匹配渠道: channel='{channel_raw}', amount={amount}")

        logger.info(f"提现汇总: {len(result)} 个账户, 总金额 {total:,.2f}")
        return result
