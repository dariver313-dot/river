"""澳门娱乐城 API 连接器。

从管理后台 API 拉取三方充值/提款/人工加款数据，
转换为统一的写表指令 [{sheet, wallet, col, value}]。
"""

import base64
import hashlib
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import pysm4
import requests

logger = logging.getLogger(__name__)

# ── 渠道映射：API中的payPlatformName/三方支付名称 → 总汇钱包名 ──
CHANNEL_MAP = {
    "ABpay内嵌下单": "AB钱包", "ABpay内嵌划转": "AB钱包", "ABPAY内嵌": "AB钱包",
    "ABpay支付": "AB钱包", "234钱包支付": "234钱包", "K豆钱包支付": "K豆钱包",
    "C币钱包支付": "C币钱包", "988钱包支付": "988钱包", "988PAY": "988钱包",
    "988钱包": "988钱包", "OkPay支付": "OK钱包", "OKPAY": "OK钱包",
    "宏威支付": "宏威支付", "365钱包支付": "365钱包", "JD钱包支付": "JD钱包",
    "808钱包支付": "808钱包", "红豆钱包支付": "红豆钱包", "臻选支付": "臻选支付",
    "星座支付": "星座支付", "金利汇支付": "金利汇支付", "GOpay": "GO钱包",
    "ET支付": "ET支付", "盛联支付": "盛联支付", "盛联支付1": "盛联支付",
    "JDPAY": "JD钱包", "ABPAY": "AB钱包", "C币代付": "C币钱包",
    "CBPAY": "C币钱包", "234币代付": "234钱包", "K豆代付": "K豆钱包",
    "KDPAY": "K豆钱包", "OK代付": "OK钱包", "OKpay": "OK钱包",
    "988钱包代付": "988钱包", "365钱包": "365钱包",
    "红豆钱包": "红豆钱包", "808钱包": "808钱包",
}

GROUP_CODE_MAP = {
    "如意": "如意群码", "村长": "村长群码",
    "顺利": "顺利群码", "发财": "发财群码",
}


class AomenAPI:
    """澳门娱乐城管理后台 API 连接器。"""

    def __init__(self, token: str, base_url: str = "https://bm1.5vlk0.com", proxy: str = None):
        self.token = token
        self.base_url = base_url.rstrip("/")
        key_hex = hashlib.md5(token.encode()).hexdigest().upper()
        self._sm4_key = bytes.fromhex(key_hex)
        # 代理: None=自动检测系统代理, ""=不用代理, "http://127.0.0.1:7890"=指定代理
        self.proxy = proxy if proxy is not None else None
        self._proxies = None
        if proxy:
            self._proxies = {"http": proxy, "https": proxy}
        elif proxy is None:
            # 自动使用系统环境变量 HTTP_PROXY/HTTPS_PROXY
            import os
            http_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or os.environ.get("https_proxy") or os.environ.get("http_proxy")
            if http_proxy:
                self._proxies = {"http": http_proxy, "https": http_proxy}
        # proxy="" → self._proxies stays None → requests doesn't use proxy

    def _headers(self) -> dict:
        ts = str(int(datetime.now().timestamp() * 1000))
        return {
            "accept": "application/json, text/plain, */*",
            "accept-encoding": "gzip, deflate, br",
            "accept-language": "zh-CN,zh;q=0.9",
            "cookie": f"X-AUTH-TOKEN={self.token}; sidebarStatus=0",
            "lang": "zh-CN",
            "referer": f"{self.base_url}/",
            "x-auth-token": self.token,
            "x-tenant-code": "AMYLC",
            "x-timestamp": ts,
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/123.0.0.0 Safari/537.36"
            ),
        }

    def _sm4_decrypt(self, encrypted_b64: str) -> Optional[dict]:
        try:
            raw = base64.b64decode(encrypted_b64)
            decrypted = pysm4.decrypt_ecb(raw, self._sm4_key)

            # pysm4 返回 str，需要正确去除 PKCS7 填充
            if isinstance(decrypted, str):
                data = decrypted.encode("latin-1")
            else:
                data = decrypted

            # PKCS7 unpad: 最后一个字节 = 填充长度(1~16)
            pad_len = data[-1]
            if 1 <= pad_len <= 16:
                data = data[:-pad_len]

            text = data.decode("utf-8", errors="ignore")
            text = text.strip()

            # 找 JSON 边界
            idx = text.rfind("}")
            if idx >= 0:
                text = text[:idx + 1]
            return json.loads(text)
        except Exception as e:
            logger.debug(f"SM4解密失败: {e}")
            return None

    def _request(self, method: str, path: str, params: dict = None,
                 data: dict = None) -> Optional[dict]:
        url = f"{self.base_url}{path}"
        kw = {"headers": self._headers(), "timeout": 10}
        if self._proxies:
            kw["proxies"] = self._proxies
        try:
            if method == "GET":
                resp = requests.get(url, params=params, **kw)
            else:
                resp = requests.post(url, params=params, json=data, **kw)

            if resp.status_code != 200:
                logger.error(f"API HTTP {resp.status_code}: {path} | {resp.text[:200]}")
                return None

            text = resp.text.strip()

            # 直接JSON解析（Brotli已由requests自动解压）
            if text and text[0] == "{":
                result = json.loads(text)
                if not result.get("success"):
                    logger.warning(f"API失败 {path}: {result.get('msg','')}")
                return result

            # SM4加密兜底（TG_Robot内部API使用）
            result = self._sm4_decrypt(text)
            if result:
                if not result.get("success"):
                    logger.warning(f"API失败(SM4) {path}: {result.get('msg','')}")
                return result

            logger.warning(f"API响应无法解析 {path}: len={len(text)}")
            return None

        except requests.exceptions.Timeout:
            logger.error(f"API超时 {path}")
            return None
        except Exception as e:
            logger.error(f"API异常 {path}: {e}")
            return None

    def _to_timestamps(self, date_str: str) -> Tuple[int, int]:
        dt = datetime.strptime(date_str, "%Y%m%d")
        # naive datetime + .timestamp() = 按本地时区(CST/UTC+8)转Unix
        start = dt.replace(hour=0, minute=0, second=0, microsecond=0)
        end = dt.replace(hour=23, minute=59, second=59, microsecond=999000)
        return (int(start.timestamp() * 1000),
                int(end.timestamp() * 1000))

    def _paginate(self, method: str, path: str, params: dict,
                  data: dict = None, max_pages: int = 30) -> List[dict]:
        all_items = []
        data = dict(data) if data else None  # 拷贝，不修改调用者的 dict
        for page in range(1, max_pages + 1):
            if data:
                data["currentPage"] = page
            elif params is None:
                params = {}
            if method == "GET" and params is not None:
                params["currentPage"] = page
            resp = self._request(method, path, params=params, data=data)
            if not resp or not resp.get("success"):
                break
            items = resp.get("items", [])
            if not items:
                break
            all_items.extend(items)
            if page >= resp.get("totalPage", 1):
                break
        return all_items

    def fetch_deposits(self, date_str: str) -> List[dict]:
        """三方充值 → [{sheet:后台, wallet, entries:[{col:B, value}]}]"""
        start_ms, end_ms = self._to_timestamps(date_str)
        instructions = []
        for mt in [3, 2]:
            params = {"pageSize": 50, "startTime": start_ms, "endTime": end_ms,
                      "orderType": 0, "timeType": 1, "memberType": mt, "status": "0000"}
            items = self._paginate("GET", "/livepro/paymentOrder/list", params)
            logger.info(f"充值(mt={mt}, {date_str}): {len(items)}条")
            for item in items:
                channel = item.get("payPlatformName", "") or ""
                wallet = CHANNEL_MAP.get(channel) or self._fuzzy_channel(channel)
                if not wallet:
                    continue
                amount = float(item.get("amount", 0) or 0)
                if amount <= 0:
                    continue
                instructions.append({
                    "sheet": "后台", "wallet": wallet,
                    "description": str(item.get("memberName", ""))[:50],
                    "entries": [{"col": "B", "value": amount}],
                    "note": "",
                })
        return instructions

    def fetch_withdrawals(self, date_str: str) -> List[dict]:
        """提款 → [{sheet:后台, wallet, entries:[{col:F, value}]}]"""
        start_ms, end_ms = self._to_timestamps(date_str)
        instructions = []
        for mt in [3, 2]:
            params = {"pageSize": 50, "timeType": 1, "status": 8,
                      "memberType": mt, "startTime": start_ms, "endTime": end_ms}
            items = self._paginate("GET", "/livepro/withdraw/list", params)
            logger.info(f"提款(mt={mt}, {date_str}): {len(items)}条")
            for item in items:
                # 优先 receivingBank, 兜底从 remark 提取
                bank = str(item.get("receivingBank", "") or "").upper()
                remark = str(item.get("remark", "") or "")
                wallet = CHANNEL_MAP.get(bank) or self._fuzzy_channel(bank)
                if not wallet and remark:
                    # remark 如 "JDPAY订单:20260604235919991R975" → 提取前缀
                    prefix = remark.split("订单")[0].strip().upper()
                    wallet = CHANNEL_MAP.get(prefix) or self._fuzzy_channel(prefix)
                if not wallet:
                    logger.debug(f"未映射提款渠道: bank={bank}, remark={remark[:30]}")
                    continue
                amount = float(item.get("amount", 0) or 0)
                if amount <= 0:
                    continue
                instructions.append({
                    "sheet": "后台", "wallet": wallet,
                    "description": str(item.get("memberName", ""))[:50],
                    "entries": [{"col": "F", "value": amount}],
                    "note": "",
                })
        return instructions

    def fetch_manual_deposits(self, date_str: str) -> List[dict]:
        """人工加款(账变) → [{sheet:后台, wallet, entries:[{col:D, value}]}]"""
        start_ms, end_ms = self._to_timestamps(date_str)
        data = {"pageSize": 50, "startTime": start_ms, "endTime": end_ms,
                "transTypeList": [254], "memberTypeList": [3, 2]}
        items = self._paginate("POST", "/livepro/accountChange/List", {}, data)
        logger.info(f"人工加款({date_str}): {len(items)}条")
        instructions = []
        for item in items:
            op_remark = str(item.get("operatorRemark", "") or "").strip()
            amount = float(item.get("amount", 0) or 0)
            if amount <= 0:
                continue
            wallet = GROUP_CODE_MAP.get(op_remark)
            if not wallet:
                wallet = op_remark if op_remark else None
            if not wallet:
                continue
            instructions.append({
                "sheet": "后台", "wallet": wallet,
                "description": str(item.get("memberName", ""))[:50],
                "entries": [{"col": "D", "value": amount}],
                "note": f"群码 {op_remark}",
            })
        return instructions

    def fetch_all(self, date_str: str) -> List[dict]:
        all_inst = []
        all_inst += self.fetch_deposits(date_str)
        all_inst += self.fetch_withdrawals(date_str)
        all_inst += self.fetch_manual_deposits(date_str)
        logger.info(f"澳门API总计: {len(all_inst)}条")
        return all_inst

    @staticmethod
    def _fuzzy_channel(channel: str) -> Optional[str]:
        if not channel:
            return None
        clean = channel.lower().replace(" ", "").replace("(中国)", "").replace("支付", "")
        for key, val in CHANNEL_MAP.items():
            k = key.lower().replace(" ", "").replace("(中国)", "").replace("支付", "")
            if clean == k or clean in k or k in clean:
                return val
        return None
