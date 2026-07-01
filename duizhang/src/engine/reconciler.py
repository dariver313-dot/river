"""对账编排器 v2 — 基于真实 Excel 结构。

两种数据源:
  A. 后台 sheet (人工已汇总) → run()
  B. 冲提表原始文件 (自动聚合) → run_from_raw()

数据流:
  原始数据 → 筛选→聚合→映射→ 总汇账户行 → L=M+F+G+H-I-J-K → 输出
"""

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional

import openpyxl

from .backend_reader import BackendReader
from .raw_data_reader import RawDataReader
from .chat_parser import ChatParser, ChatToAccountMapper
from ..writers.backend_writer import BackendWriter

logger = logging.getLogger(__name__)


@dataclass
class AccountRow:
    """总汇中一个账户行的完整数据。"""
    account_name: str
    login_name: str = ""
    charge_online: float = 0.0     # F 会员充值
    unsubmitted: float = 0.0        # G 未提交
    charge_manual: float = 0.0      # H 人工充值
    transfer_out: float = 0.0       # I 资金转出
    withdrawal: float = 0.0         # J 会员取款
    fee: float = 0.0                # K 手续费
    balance: float = 0.0            # L 余额 (计算得出)
    yesterday_balance: float = 0.0  # M 昨日余额(人民币)
    usdt_yesterday: float = 0.0     # N USDT昨日余额


@dataclass
class ReconciliationResult:
    """一次对账的完整结果。"""
    platform_name: str
    target_date: str
    accounts: Dict[str, AccountRow] = field(default_factory=dict)
    totals: Dict[str, float] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


class Reconciler:
    """三平台对账编排器。

    输入: 平台配置 + 数据文件路径
    输出: ReconciliationResult (可直接传给 ExcelWriter)
    """

    def __init__(self, platform_config: dict):
        self.config = platform_config
        self.platform_name = platform_config["name"]
        self.cells = platform_config["template_cells"]
        self.wallet_map = platform_config.get("wallet_account_map", {})

        self.backend_reader = BackendReader(platform_config)

    def run(
        self,
        data_file: str,
        yesterday_file: Optional[str] = None,
        manual_entries: Optional[Dict[str, Dict[str, float]]] = None,
        target_date: Optional[str] = None,
    ) -> ReconciliationResult:
        """执行完整对账。

        Args:
            data_file: 当日数据文件（含后台sheet）
            yesterday_file: 昨日对账输出文件（读取M列余额），None则用今日文件中的M列
            manual_entries: 人工记账 {账户名: {"charge_manual": xxx, "transfer_out": xxx}}
            target_date: 目标日期 YYYYMMDD

        Returns:
            ReconciliationResult
        """
        if target_date is None:
            target_date = date.today().strftime("%Y%m%d")

        result = ReconciliationResult(
            platform_name=self.platform_name,
            target_date=target_date,
        )
        logger.info(f"========== {self.platform_name} 开始对账 ({target_date}) ==========")

        # 1. 读取后台钱包每日汇总
        try:
            wallet_summaries = self.backend_reader.read_summaries(data_file)
        except Exception as e:
            result.errors.append(f"读取后台数据失败: {e}")
            return result

        # 2. 读取昨日余额 (M列)
        yesterday_file = yesterday_file or data_file
        yesterday_balances = self._read_yesterday_balances(yesterday_file)
        logger.info(f"读取昨日余额: {len(yesterday_balances)} 个账户")

        # 3. 初始化所有总汇账户行（从模版读取账户列表，保证与writer一致）
        template = self.config.get("template", data_file)
        account_rows = self._init_account_rows(template, yesterday_balances)

        # 4. 映射后台钱包数据 → 总汇账户
        for wallet_name, summary in wallet_summaries.items():
            account_name = self.wallet_map.get(wallet_name)
            if not account_name:
                # 尝试模糊匹配
                account_name = self._fuzzy_match(wallet_name, list(account_rows.keys()))

            if account_name and account_name in account_rows:
                row = account_rows[account_name]
                row.charge_online += summary["charge_online"]
                row.unsubmitted += summary["unsubmitted"]
                row.charge_manual += summary.get("charge_manual", 0)
                row.transfer_out += summary["transfer_out"]
                row.withdrawal += summary["withdrawal"]
                row.fee += summary["fee"]
            else:
                logger.debug(f"钱包 '{wallet_name}' 无对应总汇账户，跳过")

        # 5. 合并人工记账数据
        if manual_entries:
            for acct_name, entries in manual_entries.items():
                if acct_name in account_rows:
                    row = account_rows[acct_name]
                    row.charge_manual += entries.get("charge_manual", 0)
                    row.transfer_out += entries.get("transfer_out", 0)
                else:
                    result.warnings.append(f"人工记账账户 '{acct_name}' 不在总汇账户列表中")

        # 6. 计算余额 L = M + F + G + H - I - J - K
        for row in account_rows.values():
            row.balance = (
                row.yesterday_balance
                + row.charge_online
                + row.unsubmitted
                + row.charge_manual
                - row.transfer_out
                - row.withdrawal
                - row.fee
            )

        # 7. 计算合计行
        result.accounts = account_rows
        result.totals = {
            "charge_online": sum(r.charge_online for r in account_rows.values()),
            "unsubmitted": sum(r.unsubmitted for r in account_rows.values()),
            "charge_manual": sum(r.charge_manual for r in account_rows.values()),
            "transfer_out": sum(r.transfer_out for r in account_rows.values()),
            "withdrawal": sum(r.withdrawal for r in account_rows.values()),
            "fee": sum(r.fee for r in account_rows.values()),
            "balance": sum(r.balance for r in account_rows.values()),
            "yesterday_balance": sum(r.yesterday_balance for r in account_rows.values()),
        }

        t = result.totals
        logger.info(
            f"{self.platform_name} 对账完成 | "
            f"F(充值)={t['charge_online']:,.0f} H(人工)={t['charge_manual']:,.0f} "
            f"I(转出)={t['transfer_out']:,.0f} J(取款)={t['withdrawal']:,.0f} "
            f"K(手续费)={t['fee']:,.0f} L(余额)={t['balance']:,.0f}"
        )

        return result

    def run_from_raw(
        self,
        yesterday_file: Optional[str] = None,
        target_date: Optional[str] = None,
    ) -> ReconciliationResult:
        """从冲提表原始文件执行对账（无需人工汇总后台）。

        自动读取各平台的充值/提款CSV或XLSX，
        筛选→分组→映射→汇总→计算余额。

        Args:
            yesterday_file: 昨日输出文件（读取M列余额），None则从模版读
            target_date: 目标日期 YYYYMMDD

        Returns:
            ReconciliationResult
        """
        if target_date is None:
            target_date = date.today().strftime("%Y%m%d")

        result = ReconciliationResult(
            platform_name=self.platform_name,
            target_date=target_date,
        )
        logger.info(f"========== {self.platform_name} 冲提表模式 ({target_date}) ==========")

        # 1. 读取并聚合冲提表
        raw_reader = RawDataReader(self.config, self.config.get("_excel_dir", "excel"))
        try:
            deposit_data = raw_reader.read_deposits()
            withdraw_data = raw_reader.read_withdrawals()
        except Exception as e:
            result.errors.append(f"读取冲提表失败: {e}")
            logger.exception("读取冲提表失败")
            return result

        # 2. 读取昨日余额
        yesterday_file = yesterday_file or self.config.get("template", "")
        yesterday_balances = {}
        if yesterday_file and Path(yesterday_file).exists():
            yesterday_balances = self._read_yesterday_balances(yesterday_file)

        # 3. 初始化账户行（从模版）
        template = self.config.get("template", "")
        if not template or not Path(template).exists():
            result.errors.append(f"模版文件不存在: {template}")
            return result
        account_rows = self._init_account_rows(template, yesterday_balances)

        # 4. 填入充值数据
        for acct_name, data in deposit_data.items():
            if acct_name in account_rows:
                row = account_rows[acct_name]
                row.charge_online += data.get("charge_online", 0)
                row.charge_manual += data.get("charge_manual", 0)
            else:
                logger.debug(f"充值账户 '{acct_name}' 不在总汇中，跳过")

        # 5. 填入提现数据
        for acct_name, data in withdraw_data.items():
            if acct_name in account_rows:
                row = account_rows[acct_name]
                row.withdrawal += data.get("withdrawal", 0)
                row.fee += data.get("fee", 0)
            else:
                logger.debug(f"提现账户 '{acct_name}' 不在总汇中，跳过")

        # 6. 计算余额 L = M + F + G + H - I - J - K
        for row in account_rows.values():
            row.balance = (
                row.yesterday_balance
                + row.charge_online + row.unsubmitted + row.charge_manual
                - row.transfer_out - row.withdrawal - row.fee
            )

        # 7. 合计
        result.accounts = account_rows
        result.totals = {
            "charge_online": sum(r.charge_online for r in account_rows.values()),
            "unsubmitted": sum(r.unsubmitted for r in account_rows.values()),
            "charge_manual": sum(r.charge_manual for r in account_rows.values()),
            "transfer_out": sum(r.transfer_out for r in account_rows.values()),
            "withdrawal": sum(r.withdrawal for r in account_rows.values()),
            "fee": sum(r.fee for r in account_rows.values()),
            "balance": sum(r.balance for r in account_rows.values()),
            "yesterday_balance": sum(r.yesterday_balance for r in account_rows.values()),
        }

        t = result.totals
        logger.info(
            f"{self.platform_name} 冲提表对账完成 | "
            f"F(充值)={t['charge_online']:,.0f} H(人工)={t['charge_manual']:,.0f} "
            f"J(取款)={t['withdrawal']:,.0f} L(余额)={t['balance']:,.0f}"
        )

        return result

    def run_full(
        self,
        chat_text: str = "",
        yesterday_file: Optional[str] = None,
        target_date: Optional[str] = None,
    ) -> ReconciliationResult:
        """全流程：冲提表(F/J) + 群聊解析(G/H/I/K) + 昨日余额(M) → 总汇。

        三路数据合一，完整覆盖 F/G/H/I/J/K 六列。

        Args:
            chat_text: 群聊记录文本
            yesterday_file: 昨日输出文件
            target_date: 目标日期
        """
        if target_date is None:
            target_date = date.today().strftime("%Y%m%d")

        result = ReconciliationResult(
            platform_name=self.platform_name,
            target_date=target_date,
        )
        logger.info(f"========== {self.platform_name} 全流程 ({target_date}) ==========")

        # ── 1. 冲提表 → F/J ──
        raw_reader = RawDataReader(self.config, self.config.get("_excel_dir", "excel"))
        try:
            deposit_data = raw_reader.read_deposits()
            withdraw_data = raw_reader.read_withdrawals()
        except Exception as e:
            result.errors.append(f"冲提表: {e}")
            return result

        # ── 2. 昨日余额 → M ──
        yesterday_file = yesterday_file or self.config.get("template", "")
        yesterday_balances = {}
        if yesterday_file and Path(yesterday_file).exists():
            yesterday_balances = self._read_yesterday_balances(yesterday_file)

        # ── 3. 初始化账户行 ──
        template = self.config.get("template", "")
        account_rows = self._init_account_rows(template, yesterday_balances)

        # ── 4. 冲提表 → F/J ──
        for acct, data in deposit_data.items():
            if acct in account_rows:
                account_rows[acct].charge_online += data.get("charge_online", 0)
                account_rows[acct].charge_manual += data.get("charge_manual", 0)
        for acct, data in withdraw_data.items():
            if acct in account_rows:
                account_rows[acct].withdrawal += data.get("withdrawal", 0)
                account_rows[acct].fee += data.get("fee", 0)

        # ── 5. 群聊解析 → G/H/I/K ──
        if chat_text.strip():
            logger.info(f"{self.platform_name}: 解析群聊记录 ({len(chat_text)} 字符)")
            parser = ChatParser()
            account_names = list(account_rows.keys())
            channel_map = {}
            channel_map.update(self.wallet_map)
            raw = self.config.get("raw_data", {})
            for key in ("deposit", "withdraw"):
                channel_map.update(raw.get(key, {}).get("channel_map", {}))

            transactions = parser.parse(chat_text, self.platform_name, account_names, channel_map)
            logger.info(f"  解析出 {len(transactions)} 笔交易")

            mapper = ChatToAccountMapper(self.config)
            account_rows = mapper.apply_to_accounts(transactions, account_rows)

            # Log summary
            types = {}
            for t in transactions:
                tp = t.get("type", "unknown")
                types[tp] = types.get(tp, 0) + 1
            for tp, cnt in types.items():
                logger.info(f"    {tp}: {cnt} 笔")

        # ── 6. 计算余额 ──
        for row in account_rows.values():
            row.balance = (
                row.yesterday_balance
                + row.charge_online + row.unsubmitted + row.charge_manual
                - row.transfer_out - row.withdrawal - row.fee
            )

        # ── 7. 合计 ──
        result.accounts = account_rows
        result.totals = {
            "charge_online": sum(r.charge_online for r in account_rows.values()),
            "unsubmitted": sum(r.unsubmitted for r in account_rows.values()),
            "charge_manual": sum(r.charge_manual for r in account_rows.values()),
            "transfer_out": sum(r.transfer_out for r in account_rows.values()),
            "withdrawal": sum(r.withdrawal for r in account_rows.values()),
            "fee": sum(r.fee for r in account_rows.values()),
            "balance": sum(r.balance for r in account_rows.values()),
            "yesterday_balance": sum(r.yesterday_balance for r in account_rows.values()),
        }

        t = result.totals
        logger.info(
            f"{self.platform_name} 全流程完成 | "
            f"F={t['charge_online']:,.0f} G={t['unsubmitted']:,.0f} "
            f"H={t['charge_manual']:,.0f} I={t['transfer_out']:,.0f} "
            f"J={t['withdrawal']:,.0f} K={t['fee']:,.0f} L={t['balance']:,.0f}"
        )
        return result

    def run_full_v2(
        self,
        chat_text: str = "",
        yesterday_file: Optional[str] = None,
        target_date: Optional[str] = None,
    ):
        # Returns: (ReconciliationResult, work_file_path: str)
        """正确流程：冲提表+群聊 → 逐笔写后台 → 公式自动汇总总汇。

        1. 冲提表 → 逐笔交易列表
        2. 群聊 → AI解析 → 交易列表
        3. 昨日余额 → H6期初余额
        4. 全部写入后台 sheet（各钱包列组明细行 + H6期初余额）
        5. 读后台 Row 4 汇总（用于日志验证）
        6. 映射到总汇（仅用于日志，不覆盖公式）
        """
        if target_date is None:
            target_date = date.today().strftime("%Y%m%d")

        result = ReconciliationResult(
            platform_name=self.platform_name,
            target_date=target_date,
        )
        logger.info(f"========== {self.platform_name} 全流程V2 ({target_date}) ==========")

        raw_reader = RawDataReader(self.config)
        output_dir = self.config.get("_global", {}).get("output", {}).get("dir", "data/output")
        template = self.config.get("template", "")

        # ── 0. ★ 性能优化：用 read_only 一次性扫描模板，获取所有元数据 ──
        account_names = []
        wallet_cols = {}       # {钱包名: 起始列}
        usdt_wallet_cols = {}  # {USDT钱包名: 起始列}
        backend_sheet = self.config.get("backend_sheet", {}).get("sheet", "后台")
        wallet_row = self.config.get("backend_sheet", {}).get("wallet_header_row", 2)
        cols_per_wallet = self.config.get("backend_sheet", {}).get("columns_per_wallet", 10)

        if template and Path(template).exists():
            # read_only 模式秒开，不加载全量单元格
            wb_scan = openpyxl.load_workbook(template, read_only=True)

            # 总汇账户名 — C列(普通账户) + B列(USDT账户Row64-69)
            if self.cells["sheet"] in wb_scan.sheetnames:
                ws_hui = wb_scan[self.cells["sheet"]]
                # 普通账户: C列 (帐户名)
                for row in ws_hui.iter_rows(
                    min_row=self.cells["data_start_row"],
                    max_row=55,  # USDT账户在Row66+
                    min_col=3, max_col=3
                ):
                    for cell in row:
                        v = str(cell.value).strip() if cell.value else ""
                        if v and not v.startswith("=") and not v.startswith("SUM"):
                            account_names.append(v)
                # USDT账户: B列 (编号, Row64-69)
                for row in ws_hui.iter_rows(min_row=64, max_row=69, min_col=2, max_col=2):
                    for cell in row:
                        v = str(cell.value).strip() if cell.value else ""
                        if v and v.upper().startswith("USDT"):
                            account_names.append(v)

            # 后台钱包列位置
            if backend_sheet in wb_scan.sheetnames:
                ws_be = wb_scan[backend_sheet]
                for row in ws_be.iter_rows(min_row=wallet_row, max_row=wallet_row):
                    for cell in row:
                        if cell.value and str(cell.value).strip() not in ("", "0", "#VALUE!", "#REF!"):
                            wallet_cols[str(cell.value).strip()] = cell.column
                logger.info(f"扫描: {len(account_names)}个账户, {len(wallet_cols)}个后台钱包")

            # USDT钱包列位置
            if "USDT" in wb_scan.sheetnames:
                ws_usdt = wb_scan["USDT"]
                for row in ws_usdt.iter_rows(min_row=wallet_row, max_row=wallet_row):
                    for cell in row:
                        if cell.value and str(cell.value).strip() not in ("", "0", "#VALUE!", "#REF!"):
                            usdt_wallet_cols[str(cell.value).strip()] = cell.column
                logger.info(f"扫描: {len(usdt_wallet_cols)}个USDT钱包")

            wb_scan.close()

        # ── 1. 冲提表 / API → 统一写表指令 ──
        all_instructions = []
        api_token = self.config.get("_api_token", "")

        if api_token:
            # ★ 使用 API 拉取数据（澳门）
            try:
                from ..connectors.aomen_api import AomenAPI
                target_date = self.config.get("_target_date", target_date)
                api_cfg = self.config.get("api", {})
                base_url = api_cfg.get("base_url", "https://bm3.5vlk0.com")
                proxy = api_cfg.get("proxy", None)
                api = AomenAPI(token=api_token, base_url=base_url, proxy=proxy)
                api_instructions = api.fetch_all(str(target_date))
                all_instructions += api_instructions
                logger.info(f"API拉取 → {len(api_instructions)}条写表指令")
            except Exception as e:
                result.errors.append(f"API: {e}")
                logger.exception("API拉取失败")
                return result, ""
        else:
            # 使用本地冲提表文件
            try:
                deposit_txns = raw_reader.read_deposit_transactions()
                manual_txns = raw_reader.read_manual_deposit_transactions()
                withdraw_txns = raw_reader.read_withdraw_transactions()
                all_instructions += BackendWriter.deposit_to_instructions(deposit_txns, manual_txns)
                all_instructions += BackendWriter.withdraw_to_instructions(withdraw_txns)
            except Exception as e:
                result.errors.append(f"冲提表: {e}")
                return result, ""
            logger.info(f"冲提表 → {len(all_instructions)}条写表指令")

        # ── 2. 群聊 → AI 直接输出写表指令 ──
        if chat_text.strip():
            backend_wallets = list(wallet_cols.keys())
            usdt_wallets = list(usdt_wallet_cols.keys())

            # 合并所有渠道别名
            channel_map = {}
            channel_map.update(self.wallet_map)
            raw = self.config.get("raw_data", {})
            for key in ("deposit", "withdraw"):
                channel_map.update(raw.get(key, {}).get("channel_map", {}))

            parser = ChatParser()
            chat_instructions = parser.parse(
                chat_text, self.platform_name,
                backend_wallets=backend_wallets,
                usdt_wallets=usdt_wallets,
                channel_map=channel_map,
            )
            all_instructions += chat_instructions
            logger.info(f"群聊 → {len(chat_instructions)}条写表指令")

        # ── 3. 纯执行：写交易数据到后台+USDT（不写余额/期初，不碰公式） ──
        backend_writer = BackendWriter(self.config, output_dir)
        try:
            work_file = backend_writer.build_daily_file(
                write_instructions=all_instructions,
                target_date=target_date,
                wallet_cols=wallet_cols,
                usdt_wallet_cols=usdt_wallet_cols,
            )
            logger.info(f"交易写入完成: {work_file}")
        except Exception as e:
            result.errors.append(f"写入失败: {e}")
            logger.exception("写入失败")

        # ── 4. 余额结转：数据源总汇余额 → 模板总汇昨日余额列 ──
        yesterday_file = yesterday_file or self.config.get("template", "")
        if yesterday_file and Path(yesterday_file).exists():
            from .balance_carry import carry_balances
            carry_balances(
                source_file=yesterday_file,
                template_file=work_file,
                output_file=work_file,
            )
            logger.info(f"余额结转完成: {yesterday_file} → {work_file}")

        # ── 4.5. 后台备注解析 → 调账（下发/内充→资金转出, 修改金额→人工充值） ──
        try:
            from .adjustment_parser import parse_backend_notes, apply_adjustments
            adjustments = parse_backend_notes(work_file)
            if adjustments:
                apply_adjustments(work_file, adjustments)
                logger.info(f"备注调账完成: {len(adjustments)}个钱包")
        except Exception as e:
            logger.warning(f"备注解析跳过: {e}")

        # ── 5. 汇总日志（从写表指令统计） ──

        # ── 5. 汇总日志（从写表指令统计） ──
        col_totals: Dict[str, Dict[str, float]] = {}
        for inst in all_instructions:
            if inst.get("sheet") != "后台":
                continue
            wallet = inst.get("wallet", "")
            if wallet not in col_totals:
                col_totals[wallet] = {}
            for e in inst.get("entries", []):
                col = e["col"]
                col_totals[wallet][col] = col_totals[wallet].get(col, 0) + e["value"]

        t = {
            "charge_online": sum(c.get("B", 0) for c in col_totals.values()),
            "unsubmitted": sum(c.get("C", 0) for c in col_totals.values()),
            "charge_manual": sum(c.get("D", 0) for c in col_totals.values()),
            "transfer_out": sum(c.get("E", 0) for c in col_totals.values()),
            "withdrawal": sum(c.get("F", 0) for c in col_totals.values()),
            "fee": sum(c.get("G", 0) for c in col_totals.values()),
            "balance": 0,
            "yesterday_balance": 0,
        }
        result.totals = t
        logger.info(
            f"{self.platform_name} V3完成 | "
            f"F={t['charge_online']:,.0f} G={t['unsubmitted']:,.0f} "
            f"H={t['charge_manual']:,.0f} I={t['transfer_out']:,.0f} "
            f"J={t['withdrawal']:,.0f} K={t['fee']:,.0f}"
        )
        return result, work_file

    def _init_account_rows(
        self, file_path: str, yesterday_balances: Dict[str, float]
    ) -> Dict[str, AccountRow]:
        """从模版总汇 sheet 读取所有账户行，初始化 AccountRow。"""
        wb = openpyxl.load_workbook(file_path, data_only=True)
        ws = wb[self.cells["sheet"]]

        rows = {}
        for r in range(self.cells["data_start_row"], self.cells["data_end_row"] + 1):
            name = ws[f"{self.cells['col_account']}{r}"].value
            if not name:
                continue
            name = str(name).strip()

            login = ws[f"{self.cells['col_login']}{r}"].value or ""
            yesterday = yesterday_balances.get(name, 0.0)

            rows[name] = AccountRow(
                account_name=name,
                login_name=str(login),
                yesterday_balance=yesterday,
            )

        wb.close()
        logger.debug(f"初始化 {len(rows)} 个账户行")
        return rows

    def _read_yesterday_balances(self, file_path: str) -> Dict[str, float]:
        """读取昨日文件的 L列(余额) + N列(USDT余额) 作为今日的 M列(昨日余额)。

        覆盖普通账户(Row5-55)和USDT账户(Row56-70)。
        返回 {"账户名": 人民币余额, "@USDT_账户名": USDT余额}
        """
        try:
            wb = openpyxl.load_workbook(file_path, data_only=True)
            ws = wb[self.cells["sheet"]]

            balances = {}
            max_row = max(self.cells["data_end_row"], 70)  # 至少扫到Row70(USDT)
            for r in range(self.cells["data_start_row"], max_row + 1):
                name = ws[f"{self.cells['col_account']}{r}"].value
                if not name:
                    continue
                name = str(name).strip()

                # L列(人民币余额) → 今日M列
                l_val = ws[f"{self.cells['col_balance']}{r}"].value
                try:
                    balances[name] = float(l_val) if l_val is not None else 0.0
                except (ValueError, TypeError):
                    balances[name] = 0.0

                # N列(备注, USDT账户复用为USDT余额) → 今日N列
                n_val = ws[f"{self.cells.get('col_remark', 'N')}{r}"].value
                try:
                    n_num = float(n_val) if n_val is not None else 0.0
                    if n_num != 0 or name.upper().startswith("USDT"):
                        balances[f"@USDT_{name}"] = n_num
                except (ValueError, TypeError):
                    pass

            wb.close()
            cny_total = sum(v for k, v in balances.items() if not k.startswith("@"))
            logger.info(f"余额结转: {len(balances)}个账户, 总额{cny_total:,.0f}")
            return balances
        except Exception as e:
            logger.warning(f"读取昨日余额失败: {e}")
            return {}

    def _read_usdt_opening(self, yesterday_file: str, usdt_wallet: str,
                            yesterday_balances: dict = None) -> tuple:
        """读取昨日 USDT 期末余额作为今日期初。

        优先读最后数据行运行余额(硬值,最可靠) → Row4汇总 → Row6期初。
        Returns: (人民币余额, USDT余额)
        """
        if not yesterday_file or not Path(yesterday_file).exists():
            return 0.0, 0.0
        try:
            wb = openpyxl.load_workbook(yesterday_file, data_only=True)
            if "USDT" not in wb.sheetnames:
                wb.close()
                return 0.0, 0.0
            ws = wb["USDT"]
            for col in range(1, min(ws.max_column, 200)):
                name = ws.cell(2, col).value
                if not name or str(name).strip() != usdt_wallet:
                    continue

                # ① 最优：最后数据行的运行余额（系统写入的硬值）
                last_cny, last_usdt = 0.0, 0.0
                for r in range(12, 500):
                    v = ws.cell(r, col + 9).value   # W/J/AJ/AV
                    if v is not None:
                        try: last_cny = float(v)
                        except: pass
                    v = ws.cell(r, col + 10).value  # X/K/AK/AW
                    if v is not None:
                        try: last_usdt = float(v)
                        except: pass

                if last_cny != 0 or last_usdt != 0:
                    wb.close()
                    logger.debug(f"USDT期初(数据行) {usdt_wallet}: CNY={last_cny:.2f}, USDT={last_usdt:.2f}")
                    return last_cny, last_usdt

                # ② 其次：Row4汇总公式缓存
                cny_val = float(ws.cell(4, col + 9).value or 0)
                usdt_val = float(ws.cell(4, col + 10).value or 0)
                if cny_val != 0 or usdt_val != 0:
                    wb.close()
                    logger.debug(f"USDT期初(Row4) {usdt_wallet}: CNY={cny_val:.2f}, USDT={usdt_val:.2f}")
                    return cny_val, usdt_val

                # ③ 最后：Row6期初（上期写入值）
                cny_val = float(ws.cell(6, col + 9).value or 0)
                usdt_val = float(ws.cell(6, col + 10).value or 0)
                wb.close()
                logger.debug(f"USDT期初(Row6) {usdt_wallet}: CNY={cny_val:.2f}, USDT={usdt_val:.2f}")
                return cny_val, usdt_val

            wb.close()
        except Exception as e:
            logger.debug(f"读取USDT期初失败({usdt_wallet}): {e}")
        return 0.0, 0.0

    def _fuzzy_match(self, wallet_name: str, account_names: List[str]) -> Optional[str]:
        """模糊匹配钱包名 → 总汇账户名。"""
        wallet_lower = wallet_name.lower().replace(" ", "").replace("钱包", "")
        for acct in account_names:
            acct_lower = acct.lower().replace(" ", "").replace("钱包", "")
            if wallet_lower == acct_lower or wallet_lower in acct_lower or acct_lower in wallet_lower:
                return acct
        return None
