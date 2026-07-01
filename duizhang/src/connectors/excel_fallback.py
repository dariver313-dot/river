"""Excel 文件读取连接器（兜底方案）。

保留旧的从 Excel 文件读取数据的能力。
当 API 不可用或调试时使用。
"""

import logging
from datetime import date

import pandas as pd

logger = logging.getLogger(__name__)


class ExcelFallbackConnector:
    """从本地 Excel 文件读取充值/提现数据。

    这是 API 的兜底方案 — 用法和旧 man.py 一样，
    用户手动选择 Excel 文件然后处理。
    """

    def __init__(self, field_mapping: dict = None):
        # field_mapping 可选：如果需要把 Excel 列名也标准化
        self.field_mapping = field_mapping or {}
        self.field_mapping_reverse = {v: k for k, v in self.field_mapping.items()}

    def read(self, file_path: str, sheet_name: str = 0) -> pd.DataFrame:
        """读取 Excel 文件。

        Args:
            file_path: Excel 文件路径
            sheet_name: sheet 名（默认第一个）

        Returns:
            DataFrame
        """
        logger.info(f"读取 Excel: {file_path}, sheet={sheet_name}")
        df = pd.read_excel(file_path, sheet_name=sheet_name)
        logger.info(f"读取完成: {len(df)} 条记录")

        # 如果配置了 field_mapping，也做列名标准化
        if self.field_mapping_reverse:
            df = df.rename(columns=self.field_mapping_reverse)

        return df
