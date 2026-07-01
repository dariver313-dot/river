"""AI 群聊解析器 v2。

让 AI 直接输出写入指令 {sheet, wallet, col, value}，
Python 退化为纯执行器：校验 → 写入 → 余额。
"""

import json
import logging
import os
import re
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# ── 列定义（告诉AI模板结构） ──
SHEET_DEFINITIONS = """
## 表格结构

### 后台 sheet（每钱包10列）:
| 列 | 含义 | 适用场景 |
|----|------|---------|
| A | 用户名/描述 | 会员账号 或 交易描述 |
| B | 会员充值 | 第三方支付平台的会员充值 |
| C | 未提交 | USDT转入钱包 或 预付 |
| D | 人工充值 | 群码扫码、捐款、手动存入 |
| E | 资金转出 | 钱包转出到USDT |
| F | 会员取款 | 会员提现 |
| G | 手续费 | 提现手续费、调整手续费 |
| H | 余额 | (系统自动计算，不要填) |
| I | 备注 | 补充说明 |

### USDT sheet（每钱包13列）:
| 列 | 含义 | 适用场景 |
|----|------|---------|
| N | 描述 | 交易描述 |
| O | 人民币入款 | 其他收入(人民币) |
| P | USDT收入 | 钱包转入USDT / 群码转USDT |
| Q | 人民币未提交 | 钱包转入USDT对应的人民币 |
| R | 人工存入 | 人工存入(人民币) |
| S | USDT支出 | USDT转出到钱包 / USDT费用支出 |
| T | 人民币转出 | USDT支出对应的人民币 |
| U | 人民币手续费 | 人民币手续费 |
| V | 汇率 | USDT/CNY汇率 |
| W | 人民币余额 | (系统自动计算) |
| X | USDT余额 | (系统自动计算) |
| Y | 备注 | 补充说明 |
"""

OUTPUT_SCHEMA = """
## 输出格式 — 直接写表指令

每条消息可能产生多行（多钱包、多表），每行是一条写表指令：

[
  {
    "sheet": "后台",
    "wallet": "AB钱包",
    "description": "USDT2005 转",
    "entries": [
      {"col": "C", "value": 70000}
    ],
    "note": "内充10000u 汇率7"
  },
  {
    "sheet": "USDT",
    "wallet": "USDT9",
    "description": "USDT2005 转 AB钱包",
    "entries": [
      {"col": "S", "value": 10000},
      {"col": "T", "value": 70000},
      {"col": "V", "value": 7}
    ]
  }
]

## 规则:
1. wallet 必须从提供的钱包列表中精确匹配
2. col 只能使用上面列定义中的字母
3. value 必须是数字(float)，不要千位分隔符
4. 不要填 H(余额)/W(人民币余额)/X(USDT余额)，系统自动计算
5. 一条群聊消息可能产生多条写表指令（例如USDT→钱包同时在USDT和后台各写一行）
6. 只输出JSON数组，不要解释文字
"""


class ChatParser:
    """AI 解析群聊 → 直接输出写表指令。"""

    def __init__(self, api_key: str = None):
        self.api_key = api_key or os.environ.get(
            "DEEPSEEK_API_KEY", "") or os.environ.get("ANTHROPIC_API_KEY", "")
        self.provider = "deepseek" if os.environ.get("DEEPSEEK_API_KEY") else (
            "anthropic" if os.environ.get("ANTHROPIC_API_KEY") else None)

    def parse(
        self,
        chat_text: str,
        platform_name: str,
        backend_wallets: List[str] = None,
        usdt_wallets: List[str] = None,
        channel_map: dict = None,
    ) -> List[dict]:
        """解析群聊 → [{sheet, wallet, description, entries: [{col, value}], note}]。

        Args:
            chat_text: 群聊文本
            platform_name: 平台名
            backend_wallets: 后台钱包名列表
            usdt_wallets: USDT钱包名列表
            channel_map: 渠道别名映射

        Returns:
            写表指令列表
        """
        if not chat_text.strip():
            return []

        backend_wallets = backend_wallets or []
        usdt_wallets = usdt_wallets or []

        if self.api_key:
            try:
                if self.provider == "deepseek":
                    return self._ai_parse(chat_text, platform_name,
                                          backend_wallets, usdt_wallets, channel_map,
                                          self._call_deepseek)
                else:
                    return self._ai_parse(chat_text, platform_name,
                                          backend_wallets, usdt_wallets, channel_map,
                                          self._call_anthropic)
            except Exception as e:
                logger.warning(f"AI 解析失败: {e}，回退规则解析")
        else:
            logger.info("未设置 API Key，使用规则解析")

        return self._rule_based_parse(chat_text, backend_wallets, usdt_wallets, channel_map)

    def _ai_parse(self, chat_text, platform_name, backend_wallets, usdt_wallets,
                  channel_map, api_call) -> List[dict]:
        """通用 AI 解析流程：发请求 → 清洗JSON → 校验。"""
        prompt = self._build_prompt(chat_text, platform_name,
                                     backend_wallets, usdt_wallets, channel_map)
        text = api_call(prompt)

        # 清洗 JSON
        if text.startswith("```"):
            text = text.split("\n", 1)[1]
            if text.endswith("```"):
                text = text[:-3]
        text = text.strip()

        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            # 尝试提取 JSON 数组
            match = re.search(r'\[.*\]', text, re.DOTALL)
            if match:
                result = json.loads(match.group())
            else:
                raise

        if not isinstance(result, list):
            raise ValueError("AI 输出不是数组")

        # 校验每条指令
        valid = []
        for item in result:
            cleaned = self._validate_and_clean(item, backend_wallets, usdt_wallets)
            if cleaned:
                valid.append(cleaned)
            else:
                logger.warning(f"校验失败，跳过: {str(item)[:100]}")

        logger.info(f"AI解析: {len(result)}条 → 校验通过{len(valid)}条")
        return valid

    def _call_deepseek(self, prompt: str) -> str:
        import requests
        resp = requests.post(
            "https://api.deepseek.com/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "deepseek-chat",
                "messages": [
                    {"role": "system", "content": "你是财务数据录入专家。输出严格JSON数组，不要任何解释。"},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 4096,
                "temperature": 0,
            },
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()

    def _call_anthropic(self, prompt: str) -> str:
        import anthropic
        client = anthropic.Anthropic(api_key=self.api_key)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=4096,
            system="你是财务数据录入专家。输出严格JSON数组，不要任何解释。",
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text.strip()

    def _build_prompt(self, chat_text, platform_name, backend_wallets,
                      usdt_wallets, channel_map) -> str:
        bk_list = "\n".join(f'  - {w}' for w in backend_wallets)
        usdt_list = "\n".join(f'  - {w}' for w in usdt_wallets) if usdt_wallets else "  (无)"
        ch_list = ""
        if channel_map:
            ch_list = "\n渠道别名:\n" + "\n".join(f'  "{k}" → "{v}"' for k, v in channel_map.items())

        return f"""解析以下{platform_name}群聊记录，生成写表指令。

## 后台钱包名（精确匹配）:
{bk_list}

## USDT钱包名（精确匹配）:
{usdt_list}
{ch_list}
{SHEET_DEFINITIONS}
{OUTPUT_SCHEMA}

## 常见场景示例:
- "USDT2005 转 AB钱包 10000u 70000 7" →
  [{{"sheet":"后台","wallet":"AB钱包","description":"USDT2005 转","entries":[{{"col":"C","value":70000}}],"note":"内充10000u 汇率7"}},
   {{"sheet":"USDT","wallet":"USDT2005","description":"转 AB钱包","entries":[{{"col":"S","value":10000}},{{"col":"T","value":70000}},{{"col":"V","value":7}}]}}]
- "溢源支付 转 USDT9 8000u 55200 6.9" →
  [{{"sheet":"后台","wallet":"益源支付","description":"转 USDT9","entries":[{{"col":"E","value":55200}}],"note":"下发8000u 汇率6.9"}},
   {{"sheet":"USDT","wallet":"USDT9","description":"溢源支付 转","entries":[{{"col":"P","value":8000}},{{"col":"Q","value":55200}},{{"col":"V","value":6.9}}]}}]
- "记捐款 100" → [{{"sheet":"后台","wallet":"捐款充值","description":"记捐款","entries":[{{"col":"D","value":100}}]}}]

## 群聊记录:
{chat_text}"""

    def _validate_and_clean(self, item: dict, backend_wallets: List[str],
                            usdt_wallets: List[str]) -> Optional[dict]:
        """校验并清洗单条写表指令。不通过返回None。"""
        if not isinstance(item, dict):
            return None

        sheet = str(item.get("sheet", "")).strip()
        wallet = str(item.get("wallet", "")).strip()
        if not sheet or not wallet:
            return None

        # 校验 sheet
        if sheet not in ("后台", "USDT"):
            return None

        # 校验 wallet
        if sheet == "后台" and backend_wallets:
            if wallet not in backend_wallets:
                # 模糊匹配
                matched = self._fuzzy_match_wallet(wallet, backend_wallets)
                if matched:
                    wallet = matched
                else:
                    return None
        elif sheet == "USDT" and usdt_wallets:
            if wallet not in usdt_wallets:
                matched = self._fuzzy_match_wallet(wallet, usdt_wallets)
                if matched:
                    wallet = matched
                else:
                    return None

        # 校验 entries
        entries = item.get("entries", [])
        if not isinstance(entries, list) or not entries:
            return None

        # 列白名单
        valid_cols = {
            "后台": set("ABCDEFGI"),  # 不含H(余额)
            "USDT": set("NOPQRSTUVY"),  # 不含W/X(余额)
        }
        allowed = valid_cols.get(sheet, set())

        cleaned_entries = []
        for e in entries:
            if not isinstance(e, dict):
                continue
            col = str(e.get("col", "")).strip().upper()
            if col not in allowed:
                continue
            try:
                value = float(e.get("value", 0))
            except (ValueError, TypeError):
                continue
            if value != 0:
                cleaned_entries.append({"col": col, "value": value})

        if not cleaned_entries:
            return None

        return {
            "sheet": sheet,
            "wallet": wallet,
            "description": str(item.get("description", ""))[:50],
            "entries": cleaned_entries,
            "note": str(item.get("note", ""))[:80],
        }

    @staticmethod
    def _fuzzy_match_wallet(name: str, candidates: List[str]) -> Optional[str]:
        """模糊匹配钱包名。"""
        clean = name.lower().replace(" ", "").replace("钱包", "").replace("支付", "")
        for c in candidates:
            c_clean = c.lower().replace(" ", "").replace("钱包", "").replace("支付", "")
            if clean == c_clean:
                return c
            if len(clean) >= 2 and (clean in c_clean or c_clean in clean):
                return c
        # 单字差容忍
        for c in candidates:
            c_clean = c.lower().replace(" ", "").replace("钱包", "").replace("支付", "")
            if len(set(clean) & set(c_clean)) >= len(c_clean) * 0.6:
                return c
        return None

    # ── 规则解析兜底 ──

    def _rule_based_parse(self, chat_text: str, backend_wallets: List[str],
                          usdt_wallets: List[str], channel_map: dict = None) -> List[dict]:
        """规则兜底，输出与 AI 相同的写表指令格式。"""
        results = []
        channel_map = channel_map or {}
        known = set(backend_wallets) | set(usdt_wallets) | set(channel_map.keys())

        def _match(name):
            if not name: return name
            if name in channel_map: return channel_map[name]
            if name in known: return name
            m = self._fuzzy_match_wallet(name, list(known))
            return m or name

        def _is_usdt(name):
            return bool(name and re.match(r'^USDT\d+$', str(name).upper()))

        for line in chat_text.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            line_clean = re.sub(r'^\[[\d/\s:]+\]\s*\S+\s*:\s*', '', line).strip()
            if not line_clean:
                continue

            # "X 转 Y N u M 费率"
            tm = re.search(r'(\S+)\s+转\s+(\S+)\s+([\d,.]+)\s*[uU]\s*([\d,.]+)\s*([\d.]+)?', line_clean)
            if tm:
                src, dst = tm.group(1), tm.group(2)
                usdt_amt = float(tm.group(3).replace(",", ""))
                cny_amt = float(tm.group(4).replace(",", ""))
                rate = float(tm.group(5)) if tm.group(5) else 0

                if _is_usdt(src):
                    # USDT→钱包
                    bk = _match(dst)
                    if bk in backend_wallets:
                        results.append({"sheet": "后台", "wallet": bk,
                            "description": f"{src} 转",
                            "entries": [{"col": "C", "value": cny_amt}],
                            "note": f"内充{usdt_amt:.0f}u 汇率{rate}"})
                    if src in usdt_wallets:
                        results.append({"sheet": "USDT", "wallet": src,
                            "description": f"转 {dst}",
                            "entries": [{"col": "S", "value": usdt_amt}, {"col": "T", "value": cny_amt}] + ([{"col": "V", "value": rate}] if rate else []),
                            "note": f""})
                elif _is_usdt(dst):
                    # 钱包→USDT
                    bk = _match(src)
                    if bk in backend_wallets:
                        results.append({"sheet": "后台", "wallet": bk,
                            "description": f"转 {dst}",
                            "entries": [{"col": "E", "value": cny_amt}],
                            "note": f"下发{usdt_amt:.0f}u 汇率{rate}"})
                    if dst in usdt_wallets:
                        results.append({"sheet": "USDT", "wallet": dst,
                            "description": f"{src} 转",
                            "entries": [{"col": "P", "value": usdt_amt}, {"col": "Q", "value": cny_amt}] + ([{"col": "V", "value": rate}] if rate else []),
                            "note": f""})
                continue

            # 捐款
            dm = re.search(r'(?:捐款|记捐款).*?(\d+)', line_clean) or re.search(r'(\d+)\s*(?:记捐款|捐款)', line_clean)
            if dm:
                if "捐款充值" in backend_wallets:
                    results.append({"sheet": "后台", "wallet": "捐款充值",
                        "description": "记捐款",
                        "entries": [{"col": "D", "value": float(dm.group(1))}]})
                continue

            # 支出
            em = re.search(r'支出.*?([\d,.]+)\s*[uU]\s*([\d,.]+)\s*([\d.]+)?', line_clean)
            if em:
                usdt_amt = float(em.group(1).replace(",", ""))
                cny_amt = float(em.group(2).replace(",", ""))
                rate = float(em.group(3)) if em.group(3) else 0
                # 找USDT钱包
                for uw in usdt_wallets:
                    if uw.lower() in line_clean.lower():
                        results.append({"sheet": "USDT", "wallet": uw,
                            "description": line_clean[:50],
                            "entries": [{"col": "S", "value": usdt_amt}, {"col": "T", "value": cny_amt}] + ([{"col": "V", "value": rate}] if rate else []),
                            "note": f""})
                        break
                continue

            # 会员充值
            md = re.search(r'会员充值\s+(\S+)\s+([\d,.]+)', line_clean)
            if md:
                # 不关联具体钱包，跳过
                continue

            # 会员提现
            mw = re.search(r'会员提现\s+(\S+)\s+([\d,.]+)\s*[uU]\s*([\d,.]+)', line_clean)
            if mw:
                continue

            # 群码→USDT
            gm = re.search(r'(\S+)\s*转\s*(USDT\d+)\s*([\d,.]+)\s*[uU]', line_clean)
            if gm:
                name, usdt_w = _match(gm.group(1)), gm.group(2)
                usdt_amt = float(gm.group(3).replace(",", ""))
                if name in backend_wallets:
                    results.append({"sheet": "后台", "wallet": name,
                        "description": f"转 {usdt_w}",
                        "entries": [{"col": "E", "value": usdt_amt * 7}],  # 估算CNY
                        "note": f"群码转{usdt_amt:.0f}u"})
                if usdt_w in usdt_wallets:
                    results.append({"sheet": "USDT", "wallet": usdt_w,
                        "description": f"{name} 转",
                        "entries": [{"col": "P", "value": usdt_amt}],
                        "note": f""})
                continue

            # 出款手动通过
            om = re.search(r'(\S+)\s+(\d+)\s+(\S+)出款手动通过', line_clean)
            if om:
                bk = _match(om.group(3))
                if bk in backend_wallets:
                    results.append({"sheet": "后台", "wallet": bk,
                        "description": f"{om.group(1)} 提现",
                        "entries": [{"col": "F", "value": float(om.group(2))}],
                        "note": "手动通过"})
                continue

        logger.info(f"规则解析: {len(results)} 条写表指令")
        return results


# ── 向后兼容：保留旧版 ChatToAccountMapper ──

class ChatToAccountMapper:
    """旧版映射器（run_full 兼容）。"""

    def __init__(self, platform_config: dict):
        self.config = platform_config
        self.channel_map = platform_config.get("wallet_account_map", {})
        raw = platform_config.get("raw_data", {})
        for key in ("deposit", "withdraw"):
            cm = raw.get(key, {}).get("channel_map", {})
            self.channel_map.update(cm)
        self.group_code_map = raw.get("deposit", {}).get("group_code_map", {})

    def apply_to_accounts(self, transactions, account_rows):
        for txn in transactions:
            txn_type = txn.get("type", "")
            cny = txn.get("cny_amount", 0) or 0
            fee = txn.get("fee", 0) or 0
            backend_wallet = txn.get("backend_wallet", "") or txn.get("to_account", "")
            from_acct = txn.get("from_account", "")

            if txn_type in ("usdt_to_wallet", "transfer_in") and backend_wallet:
                if backend_wallet in account_rows:
                    account_rows[backend_wallet].unsubmitted += cny
            elif txn_type in ("wallet_to_usdt", "transfer_out"):
                acct = backend_wallet or from_acct
                if acct and acct in account_rows:
                    account_rows[acct].transfer_out += cny
            elif txn_type == "member_deposit" and backend_wallet:
                if backend_wallet in account_rows:
                    account_rows[backend_wallet].charge_online += cny
            elif txn_type == "member_withdraw" and backend_wallet:
                if backend_wallet in account_rows:
                    account_rows[backend_wallet].withdrawal += cny
                    account_rows[backend_wallet].fee += fee
            elif txn_type == "donation":
                donation_acct = backend_wallet or "捐款充值"
                if donation_acct in account_rows:
                    account_rows[donation_acct].charge_manual += cny
            elif txn_type == "fee":
                if backend_wallet and backend_wallet in account_rows:
                    account_rows[backend_wallet].fee += fee
            elif txn_type == "group_code_in" and backend_wallet:
                mapped = self.group_code_map.get(backend_wallet, backend_wallet)
                if mapped in account_rows:
                    account_rows[mapped].charge_manual += cny
            elif txn_type == "group_code_out" and from_acct:
                mapped = self.group_code_map.get(from_acct, from_acct)
                if mapped in account_rows:
                    account_rows[mapped].transfer_out += cny

        return account_rows
