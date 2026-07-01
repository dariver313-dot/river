"""关键词匹配和精确匹配工具。

从 man.py 的硬编码逻辑抽取，改为配置驱动。
- match_keyword: 在字段值中查找关键词（如"操作说明"里找 AB/CB/KD）
- match_exact: 精确匹配字段值（如"操作员备注" == "如意"）
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


class Matcher:
    """通用的字段值匹配器，配置驱动。"""

    @staticmethod
    def match_keyword(value: str, mappings: dict) -> Optional[str]:
        """在 value 字符串中搜索 mappings 的 key，返回对应的 value。

        Args:
            value: 原始字段值，如 "AB钱包充值-成功"
            mappings: {关键词: 目标名}，如 {"AB": "AB钱包"}

        Returns:
            匹配到的映射值，未匹配返回 None

        Example:
            >>> Matcher.match_keyword("KD钱包提现", {"KD": "K豆钱包"})
            "K豆钱包"
        """
        if not value or not isinstance(value, str):
            return None
        for key, mapped_name in mappings.items():
            if key in value:
                return mapped_name
        return None

    @staticmethod
    def match_exact(value, mappings: dict) -> Optional[str]:
        """精确匹配 value 是否为 mappings 的 key，返回对应的 value。

        Args:
            value: 原始字段值，如 "如意"
            mappings: {原始名: 目标名}，如 {"如意": "如意群码"}

        Returns:
            匹配到的映射值，未匹配返回 None
        """
        if value is None:
            return None
        return mappings.get(str(value))
