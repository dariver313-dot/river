"""冲提表原始数据读取器。

直接从各平台的充值/提款 CSV 或 XLSX 文件中：
1. 筛选成功交易
2. 按渠道分组汇总
3. 映射渠道名 → 总汇账户名
4. 返回标准化的 AccountRow 数据

替代 BackendReader，省去人工汇总到后台 sheet 的步骤。
"""

import glob
import logging
import os
from typing import Any, Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)


class RawDataReader:
    """读取冲提表原始文件，聚合后输出标准 AccountRow 数据。

    每个平台的 raw_data 配置定义：
    - deposit: 充值文件格式
    - withdraw: 提现文件格式
    """

    def __init__(self, platform_config: dict, excel_dir: str = "excel"):
        self.config = platform_config
        self.platform_name = platform_config["name"]
        self.excel_dir = excel_dir
        self.raw_config = platform_config.get("raw_data", {})

    def read_deposit_transactions(self) -> List[dict]:
        """读取充值数据，返回逐笔交易列表。

        Returns:
            [{wallet, username, amount, type, note}, ...]
        """
        deposit_cfg = self.raw_config.get("deposit", {})
        if not deposit_cfg:
            return []

        # 优先使用用户选择的文件，否则自动查找
        filepath = self.config.get("_deposit_file", "")
        if not filepath or not os.path.exists(filepath):
            filepath = self._find_file(deposit_cfg.get("file_pattern", ""))
        if not filepath:
            return []

        logger.info(f"{self.platform_name} 逐笔充值: {os.path.basename(filepath)}")
        df = self._load_file(filepath, deposit_cfg)

        status_field = deposit_cfg.get("status_field", "")
        status_value = deposit_cfg.get("status_value", "")
        channel_field = deposit_cfg.get("channel_field", "")
        amount_field = deposit_cfg.get("amount_field", "")
        channel_map = deposit_cfg.get("channel_map", {})
        txn_type = "charge_online"

        # 特殊: 澳门类型字段
        if "type_field" in deposit_cfg:
            type_field = deposit_cfg["type_field"]
            online_type = deposit_cfg.get("online_type", "")
            manual_type = deposit_cfg.get("manual_type", "")
            manual_group_field = deposit_cfg.get("manual_group_field", "")
            group_code_map = deposit_cfg.get("group_code_map", {})

            txns = []
            # 手动微信扫码 → 群码
            if manual_type:
                manual_df = df[df[type_field] == manual_type]
                for _, row in manual_df.iterrows():
                    op = str(row.get(manual_group_field, "")).strip()
                    wallet = group_code_map.get(op, op)
                    txns.append({
                        "wallet": wallet,
                        "username": str(row.get("会员账号", "")),
                        "amount": float(row.get(amount_field, 0) or 0),
                        "type": "charge_manual",
                        "note": f"群码充值 {op}",
                    })
            return txns

        # 标准格式
        if status_field and status_field in df.columns:
            df = df[df[status_field] == status_value]

        # fallback: 当渠道字段为空时用备用字段
        fallback_field = deposit_cfg.get("fallback_field", "")
        fallback_map = deposit_cfg.get("fallback_map", {})

        # 找会员账号列
        username_col = None
        for c in df.columns:
            if str(c).strip() in ("会员账号", "会员", "账号"):
                username_col = c
                break

        txns = []
        for _, row in df.iterrows():
            raw_channel = str(row.get(channel_field, "") or "").strip()
            amount = float(row.get(amount_field, 0) or 0)
            if not amount:
                continue

            account = channel_map.get(raw_channel) if raw_channel else None
            if not account and raw_channel:
                account = self._fuzzy_match_channel(raw_channel, channel_map)

            # fallback: 渠道为空时用备用字段
            if not account and fallback_field and fallback_field in df.columns:
                fb_val = str(row.get(fallback_field, "") or "").strip()
                if fb_val in fallback_map:
                    account = fallback_map[fb_val]
                    raw_channel = fb_val

            if not account:
                account = raw_channel

            username = ""
            if username_col:
                username = str(row.get(username_col, "") or "")

            txns.append({
                "wallet": account or "",
                "username": username,
                "amount": amount,
                "type": txn_type,
                "note": f"{raw_channel}",
            })

        logger.info(f"  充值逐笔: {len(txns)} 条")
        return txns

    def read_manual_deposit_transactions(self) -> List[dict]:
        """读取人工充值数据 (群码扫码等)，返回逐笔交易列表。

        用于澳门 manual_deposit 配置。
        """
        manual_cfg = self.raw_config.get("manual_deposit", {})
        if not manual_cfg:
            return []

        # 优先手动选择，否则自动检测
        filepath = self.config.get("_manual_deposit_file", "")
        if not filepath or not os.path.exists(filepath):
            filepath = self._find_file(manual_cfg.get("file_pattern", ""))
        if not filepath:
            return []

        logger.info(f"{self.platform_name} 逐笔人工充值: {os.path.basename(filepath)}")
        df = self._load_file(filepath, manual_cfg)

        type_field = manual_cfg.get("type_field", "")
        type_value = manual_cfg.get("type_value", "")
        amount_field = manual_cfg.get("amount_field", "")
        group_field = manual_cfg.get("group_field", "")
        group_map = manual_cfg.get("group_code_map", {})

        if type_field and type_field in df.columns:
            df = df[df[type_field] == type_value]

        txns = []
        for _, row in df.iterrows():
            op_name = str(row.get(group_field, "") or "").strip()
            amount = float(row.get(amount_field, 0) or 0)
            if not amount:
                continue

            wallet = group_map.get(op_name, op_name)
            txns.append({
                "wallet": wallet,
                "username": str(row.get("会员账号", row.iloc[1] if len(row) > 1 else "")),
                "amount": amount,
                "type": "charge_manual",
                "note": f"群码充值 {op_name}",
            })

        logger.info(f"  人工充值逐笔: {len(txns)} 条")
        return txns

    def read_withdraw_transactions(self) -> List[dict]:
        """读取提现数据，返回逐笔交易列表。

        Returns:
            [{wallet, username, amount, fee, note}, ...]
        """
        withdraw_cfg = self.raw_config.get("withdraw", {})
        if not withdraw_cfg:
            return []

        filepath = self.config.get("_withdraw_file", "")
        if not filepath or not os.path.exists(filepath):
            filepath = self._find_file(withdraw_cfg.get("file_pattern", ""))
        if not filepath:
            return []

        logger.info(f"{self.platform_name} 逐笔提现: {os.path.basename(filepath)}")
        df = self._load_file(filepath, withdraw_cfg)

        status_field = withdraw_cfg.get("status_field", "")
        status_value = withdraw_cfg.get("status_value", "")
        channel_field = withdraw_cfg.get("channel_field", "")
        amount_field = withdraw_cfg.get("amount_field", "")
        channel_map = withdraw_cfg.get("channel_map", {})

        if status_field and status_field in df.columns:
            df = df[df[status_field] == status_value]

        fallback_field = withdraw_cfg.get("fallback_field", "")
        fallback_map = withdraw_cfg.get("fallback_map", {})

        # 找会员账号列
        username_col = None
        for c in df.columns:
            if str(c).strip() in ("会员账号", "会员", "账号"):
                username_col = c
                break

        txns = []
        for _, row in df.iterrows():
            raw_channel = str(row.get(channel_field, "") or "").strip()
            amount = float(row.get(amount_field, 0) or 0)
            if not amount:
                continue

            account = channel_map.get(raw_channel) if raw_channel else None
            if not account and raw_channel:
                account = self._fuzzy_match_channel(raw_channel, channel_map)

            # fallback
            if not account and fallback_field and fallback_field in df.columns:
                fb_val = str(row.get(fallback_field, "") or "").strip()
                if fb_val in fallback_map:
                    account = fallback_map[fb_val]
                    raw_channel = fb_val

            if not account:
                account = raw_channel

            # 手续费
            fee = 0.0
            for fee_col in ["手续费", "审批手续费"]:
                if fee_col in df.columns:
                    fee = float(row.get(fee_col, 0) or 0)
                    break

            # 会员账号
            username = ""
            if username_col:
                username = str(row.get(username_col, "") or "")

            txns.append({
                "wallet": account or "",
                "username": username,
                "amount": amount,
                "fee": fee,
                "note": f"{raw_channel}",
            })

        logger.info(f"  提现逐笔: {len(txns)} 条")
        return txns

    # ── 旧的聚合方法 (兼容) ──

    def read_deposits(self) -> Dict[str, Dict[str, float]]:
        """读取充值数据，返回 {账户名: {charge_online, charge_manual}}。

        Returns:
            {"AB钱包": {"charge_online": 1000, "charge_manual": 200}, ...}
        """
        deposit_cfg = self.raw_config.get("deposit", {})
        if not deposit_cfg:
            return {}

        filepath = self._find_file(deposit_cfg.get("file_pattern", ""))
        if not filepath:
            logger.warning(f"{self.platform_name}: 未找到充值文件")
            return {}

        logger.info(f"{self.platform_name} 读取充值: {os.path.basename(filepath)}")
        df = self._load_file(filepath, deposit_cfg)

        result: Dict[str, Dict[str, float]] = {}

        # 澳门娱乐城特殊格式：按变动类型区分线上充值和群码
        if "type_field" in deposit_cfg:
            type_field = deposit_cfg["type_field"]
            amount_field = deposit_cfg["amount_field"]
            online_type = deposit_cfg.get("online_type", "")
            manual_type = deposit_cfg.get("manual_type", "")
            manual_group_field = deposit_cfg.get("manual_group_field", "")
            group_code_map = deposit_cfg.get("group_code_map", {})

            # 线上充值 → F
            if online_type and online_type in df[type_field].values:
                online_df = df[df[type_field] == online_type]
                online_total = online_df[amount_field].sum()
                # 线上充值不按渠道分，直接汇总
                # Actually for 澳门, online充值需要按渠道分...但账变表没有渠道字段
                # 账变表的线上充值是一个总数
                logger.info(f"  线上充值: {online_total:,.0f}")

            # 手动微信扫码 → H (按操作员分组匹配群码)
            if manual_type and manual_type in df[type_field].values:
                manual_df = df[df[type_field] == manual_type]
                grouped = manual_df.groupby(manual_group_field)[amount_field].sum()
                for op_name, amount in grouped.items():
                    account = group_code_map.get(str(op_name).strip())
                    if account:
                        self._add_to_result(result, account, "charge_manual", amount)
                        logger.debug(f"  群码: {op_name} → {account}: {amount:,.0f}")
                    else:
                        logger.warning(f"  未知群码操作员: {op_name}, amount={amount:,.0f}")

            return result

        # 标准格式：筛选 → 分组 → 映射
        status_field = deposit_cfg.get("status_field", "")
        status_value = deposit_cfg.get("status_value", "")
        channel_field = deposit_cfg.get("channel_field", "")
        amount_field = deposit_cfg.get("amount_field", "")
        channel_map = deposit_cfg.get("channel_map", {})

        if status_field and status_field in df.columns:
            df = df[df[status_field] == status_value]
            logger.info(f"  筛选 {status_field}={status_value}: {len(df)} 条")

        if channel_field:
            grouped = df.groupby(channel_field)[amount_field].sum()
            for raw_channel, amount in grouped.items():
                channel_str = str(raw_channel).strip()
                account = channel_map.get(channel_str)
                if not account:
                    account = self._fuzzy_match_channel(channel_str, channel_map)

                if account:
                    self._add_to_result(result, account, "charge_online", amount)
                else:
                    logger.warning(f"  未映射充值渠道: '{channel_str}', amount={amount:,.0f}")
        else:
            total = df[amount_field].sum()
            logger.info(f"  充值总额: {total:,.0f}")

        return result

    def read_withdrawals(self) -> Dict[str, Dict[str, float]]:
        """读取提现数据，返回 {账户名: {withdrawal, fee}}。"""
        withdraw_cfg = self.raw_config.get("withdraw", {})
        if not withdraw_cfg:
            return {}

        filepath = self._find_file(withdraw_cfg.get("file_pattern", ""))
        if not filepath:
            logger.warning(f"{self.platform_name}: 未找到提现文件")
            return {}

        logger.info(f"{self.platform_name} 读取提现: {os.path.basename(filepath)}")
        df = self._load_file(filepath, withdraw_cfg)

        status_field = withdraw_cfg.get("status_field", "")
        status_value = withdraw_cfg.get("status_value", "")
        channel_field = withdraw_cfg.get("channel_field", "")
        amount_field = withdraw_cfg.get("amount_field", "")
        channel_map = withdraw_cfg.get("channel_map", {})

        if status_field and status_field in df.columns:
            df = df[df[status_field] == status_value]
            logger.info(f"  筛选 {status_field}={status_value}: {len(df)} 条")

        result: Dict[str, Dict[str, float]] = {}
        if channel_field and channel_field in df.columns:
            grouped = df.groupby(channel_field)[amount_field].sum()
            for raw_channel, amount in grouped.items():
                channel_str = str(raw_channel).strip()
                account = channel_map.get(channel_str)
                if not account:
                    account = self._fuzzy_match_channel(channel_str, channel_map)

                if account:
                    self._add_to_result(result, account, "withdrawal", amount)
                else:
                    logger.warning(f"  未映射提现渠道: '{channel_str}', amount={amount:,.0f}")
        else:
            total = df[amount_field].sum()
            logger.info(f"  提现总额: {total:,.0f}")

        return result

    def _load_file(self, filepath: str, config: dict) -> pd.DataFrame:
        """根据文件类型加载 CSV 或 XLSX。"""
        if filepath.endswith(".csv"):
            encoding = config.get("encoding", "utf-8")
            return pd.read_csv(filepath, encoding=encoding)
        else:
            return pd.read_excel(filepath)

    def _find_file(self, pattern: str) -> Optional[str]:
        """在 excel_dir 中查找匹配的文件。"""
        search_path = os.path.join(self.excel_dir, pattern)
        matches = sorted(glob.glob(search_path))
        if matches:
            return matches[0]  # 返回最新匹配
        return None

    def _add_to_result(self, result: dict, account: str, key: str, amount: float):
        """累加到结果字典。"""
        if account not in result:
            result[account] = {}
        result[account][key] = result[account].get(key, 0.0) + float(amount)

    def _fuzzy_match_channel(self, channel: str, channel_map: dict) -> Optional[str]:
        """模糊匹配渠道名 → 总汇账户名。"""
        # 精确匹配
        if channel in channel_map:
            return channel_map[channel]

        # 去掉常见后缀
        clean = channel.lower().replace(" ", "")
        for suffix in ["支付(中国)", "支付", "钱包支付(中国)", "钱包(中国)", "(中国)",
                         "代付", "币代付", "钱包代付", "pay"]:
            clean = clean.replace(suffix, "")

        for raw, account in channel_map.items():
            raw_clean = raw.lower().replace(" ", "")
            for suffix in ["支付(中国)", "支付", "钱包支付(中国)", "钱包(中国)", "(中国)",
                             "代付", "币代付", "钱包代付", "pay"]:
                raw_clean = raw_clean.replace(suffix, "")
            if clean == raw_clean or clean in raw_clean or raw_clean in clean:
                return account

        # 试总汇账户名直接模糊匹配
        for raw, account in channel_map.items():
            acct_clean = account.lower().replace(" ", "").replace("支付", "").replace("钱包", "")
            if clean in acct_clean or acct_clean in clean:
                return account

        return None
