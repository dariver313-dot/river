"""通用 API 连接器。

配置驱动，一个类适配所有平台的 API：
- 根据 field_mapping 自动重命名列 → 标准化
- 支持 Bearer Token 认证
- 指数退避重试
"""

import logging
from datetime import date

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

# 内部标准字段名
STANDARD_COLUMNS = ["date", "amount", "type", "operator", "channel", "status"]


class APIConnector:
    """通用 API 连接器。

    通过 platform.yaml 中的 charge_api / withdraw_api 配置驱动：
    - url: API 地址
    - token: 认证令牌
    - field_mapping: {标准字段: API返回字段}，用于列重命名
    """

    def __init__(self, api_config: dict, defaults: dict = None):
        self.url = api_config["url"]
        self.token = api_config.get("token", "")
        self.field_mapping = api_config.get("field_mapping", {})
        self.field_mapping_reverse = {v: k for k, v in self.field_mapping.items()}

        # 重试设置
        defaults = defaults or {}
        timeout = defaults.get("timeout_seconds", 30)
        retry_cfg = defaults.get("retry", {})
        max_retries = retry_cfg.get("max_attempts", 3)
        backoff = retry_cfg.get("backoff_seconds", 2)

        # 创建带重试的 session
        self.session = requests.Session()
        retry_strategy = Retry(
            total=max_retries,
            backoff_factor=backoff,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"],
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

        self.timeout = timeout

    def fetch(self, start_date: date, end_date: date) -> pd.DataFrame:
        """从 API 拉取数据并标准化。

        Args:
            start_date: 开始日期
            end_date: 结束日期

        Returns:
            标准化后的 DataFrame（列名为统一标准名）
        """
        url = self._build_url(start_date, end_date)
        headers = self._build_headers()

        logger.info(f"请求 API: {url}")
        logger.debug(f"请求头: {headers}")

        try:
            resp = self.session.get(url, headers=headers, timeout=self.timeout)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            logger.error(f"API 请求失败: {e}")
            raise ConnectionError(f"API 请求失败: {e}") from e

        # 处理不同的响应格式
        if isinstance(data, dict):
            # 尝试常见的包装格式: {"data": [...], "code": 0}
            if "data" in data:
                records = data["data"]
            elif "result" in data:
                records = data["result"]
            elif "list" in data:
                records = data["list"]
            else:
                # 整个响应当作单条记录
                records = [data]
        elif isinstance(data, list):
            records = data
        else:
            raise ValueError(f"无法解析 API 响应格式: {type(data)}")

        if not records:
            logger.warning("API 返回空数据")
            return pd.DataFrame(columns=list(STANDARD_COLUMNS))

        df = pd.DataFrame(records)
        logger.info(f"API 返回 {len(df)} 条记录, 字段: {list(df.columns)}")

        # 字段映射：API原始名 → 标准名
        df = df.rename(columns=self.field_mapping_reverse)

        # 确保标准列存在
        for col in STANDARD_COLUMNS:
            if col not in df.columns:
                logger.warning(f"缺少标准字段 '{col}'，自动填充")
                df[col] = None

        logger.info(f"标准化完成: {len(df)} 条, 字段: {list(df.columns)}")
        return df

    def health_check(self) -> bool:
        """快速检查连通性（发一个轻量请求）。"""
        try:
            resp = self.session.get(self.url, timeout=5)
            return resp.ok
        except Exception:
            return False

    def _build_url(self, start_date: date, end_date: date) -> str:
        """构建请求 URL（支持日期参数替换）。"""
        url = self.url
        # 替换 URL 中的日期占位符
        url = url.replace("{start_date}", start_date.isoformat())
        url = url.replace("{end_date}", end_date.isoformat())
        # 也可以加 query 参数（如果 URL 里没有的话）
        return url

    def _build_headers(self) -> dict:
        """构建请求头（Bearer Token 认证）。"""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers
