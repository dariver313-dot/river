"""自动做账系统 v3.3

每个平台: 昨日账表 + 充值表 + 提款表 + 群聊
  - 天游: 昨日 + 充值CSV + 提款CSV + 群聊
  - 澳博: 昨日 + 充值XLSX + 提款XLSX + 群聊
  - 澳门: 昨日 + 账变XLSX(群码) + 第三方充值XLSX + 提款XLSX + 群聊
"""

import glob, logging, os, queue, sys, threading, tkinter as tk
from datetime import date, timedelta
from pathlib import Path
from tkinter import ttk, messagebox, filedialog

sys.path.insert(0, str(Path(__file__).parent))
from src.config_loader import load_config
from src.logger import setup_logging
from src.engine.reconciler import Reconciler
from src.writers.excel_writer import ExcelWriter

logger = logging.getLogger(__name__)


class PlatformCard(ttk.LabelFrame):
    def __init__(self, parent, pid, pconfig, log_queue, output_config):
        super().__init__(parent, text=pconfig["name"], padding=6)
        self.pid = pid
        self.config = pconfig
        self.log_queue = log_queue
        self.output_config = output_config
        self._running = False

        self.yesterday_path = tk.StringVar()
        self.deposit_path = tk.StringVar()
        self.withdraw_path = tk.StringVar()
        self.manual_path = tk.StringVar()  # 澳门账变记录
        self.api_token = tk.StringVar()    # 澳门API Token
        # 日期选择（默认昨天）
        td = (date.today() - timedelta(days=1))
        self.target_date = tk.StringVar(value=td.strftime("%Y%m%d"))
        self._build()
        self._auto_detect()

    def _build(self):
        # 通用行
        rows = [
            ("昨日:", self.yesterday_path, "yesterday"),
            ("充值:", self.deposit_path, "deposit"),
            ("提款:", self.withdraw_path, "withdraw"),
        ]
        if self.config.get("raw_data", {}).get("manual_deposit"):
            rows.insert(2, ("账变:", self.manual_path, "manual"))

        for label, var, key in rows:
            f = ttk.Frame(self); f.pack(fill="x", pady=1)
            ttk.Label(f, text=label, width=5).pack(side="left")
            ttk.Entry(f, textvariable=var, width=20).pack(side="left", padx=2, fill="x", expand=True)
            ttk.Button(f, text="选", width=3, command=lambda k=key, v=var: self._browse(k, v)).pack(side="left")

        # 日期选择
        df = ttk.Frame(self); df.pack(fill="x", pady=1)
        ttk.Label(df, text="日期:", width=5).pack(side="left")
        ttk.Entry(df, textvariable=self.target_date, width=10).pack(side="left", padx=2)
        ttk.Label(df, text="(YYYYMMDD)", foreground="gray", font=("",7)).pack(side="left")

        # 澳门: API Token 输入
        if self.config.get("api"):
            tf = ttk.Frame(self); tf.pack(fill="x", pady=1)
            ttk.Label(tf, text="Token:", width=5).pack(side="left")
            ttk.Entry(tf, textvariable=self.api_token, width=20, show="*").pack(side="left", padx=2, fill="x", expand=True)

        f4 = ttk.Frame(self); f4.pack(fill="x", pady=1)
        ttk.Label(f4, text="群聊:", width=5).pack(side="left")
        self.chat_text = tk.Text(f4, height=3, width=22, font=("",7), wrap="word", bg="#f8f8f8")
        self.chat_text.pack(side="left", padx=2, fill="x", expand=True)

        f5 = ttk.Frame(self); f5.pack(fill="x", pady=(2,0))
        self.st = ttk.Label(f5, text="⏳", foreground="gray"); self.st.pack(side="left")
        self.btn = ttk.Button(f5, text="一键做账", command=self.run); self.btn.pack(side="right")
        self.last = ttk.Label(f5, text="", foreground="gray"); self.last.pack(side="right", padx=5)

    def _auto_detect(self):
        raw = self.config.get("raw_data", {})
        for key, var in [("deposit", self.deposit_path), ("manual_deposit", self.manual_path),
                           ("withdraw", self.withdraw_path)]:
            pattern = raw.get(key, {}).get("file_pattern", "")
            if pattern:
                matches = sorted(glob.glob(f"excel/{pattern}"))
                if matches: var.set(matches[-1])

    def _browse(self, key, var):
        titles = {"yesterday":"昨日账表","deposit":"充值表","manual":"账变记录表","withdraw":"提款表"}
        fn = filedialog.askopenfilename(
            title=f"{self.config['name']} - {titles.get(key,key)}",
            filetypes=[("All","*.*"),("Excel","*.xlsx"),("CSV","*.csv")], initialdir="excel")
        if fn: var.set(fn)

    def run(self):
        if self._running: return
        self._running = True; self.btn.configure(state="disabled", text="⏳...")
        self.st.configure(text="🔄", foreground="#2196F3")
        threading.Thread(target=self._do, daemon=True).start()

    def _do(self):
        name = self.config["name"]
        td = self.target_date.get().strip() or (date.today() - timedelta(days=1)).strftime("%Y%m%d")
        dep = self.deposit_path.get().strip()
        wdr = self.withdraw_path.get().strip()
        yst = self.yesterday_path.get().strip()
        chat = self.chat_text.get("1.0","end-1c").strip()
        token = self.api_token.get().strip()

        try:
            self._log(f"{'='*40}")
            self._log(f"  {name} | {td}")
            self._log(f"  昨日: {os.path.basename(yst) if yst else '无(M=0)'}")
            man = self.manual_path.get().strip()
            if token:
                self._log(f"  API: Token已设置, 将从后台拉取数据")
            else:
                self._log(f"  充值: {os.path.basename(dep) if dep else '自动'}")
                if man: self._log(f"  账变: {os.path.basename(man)}")
                self._log(f"  提款: {os.path.basename(wdr) if wdr else '自动'}")
            self._log(f"  群聊: {len(chat)}字")
            self._log(f"{'='*40}")

            self.config["_deposit_file"] = dep
            self.config["_manual_deposit_file"] = man
            self.config["_withdraw_file"] = wdr
            self.config["_api_token"] = token
            self.config["_target_date"] = td

            r = Reconciler(self.config)
            result, work_file = r.run_full_v2(
                chat_text=chat,
                yesterday_file=yst if yst else None,
                target_date=td,
            )

            if result.errors:
                for e in result.errors: self._log(f"  ❌ {e}")
                self.st.configure(text="❌", foreground="#F44336")
                return

            # 工作文件重命名为输出文件
            import shutil
            date_short = f"{int(td[4:6])}.{int(td[6:8])}"
            out_name = f"2026{name}{date_short}.xlsx"
            out_path = os.path.join("data", "output", out_name)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            # 先删旧输出文件（Windows上shutil.move不会覆盖）
            if os.path.exists(out_path):
                os.remove(out_path)
            shutil.move(work_file, out_path)
            self._log(f"  💾 {out_path}")
            t = result.totals
            self._log(f"  ✅ F={t.get('charge_online',0):,.0f} G={t.get('unsubmitted',0):,.0f} H={t.get('charge_manual',0):,.0f}")
            self._log(f"     I={t.get('transfer_out',0):,.0f} J={t.get('withdrawal',0):,.0f} K={t.get('fee',0):,.0f}")
            self._log(f"  💾 {out_path}")
            self.st.configure(text="✅", foreground="#4CAF50")
            self.last.configure(text=td)
        except Exception as e:
            self._log(f"  ❌ {e}")
            self.st.configure(text="❌", foreground="#F44336")
            logger.exception(f"{name} error")
        finally:
            self._running = False
            self.btn.configure(state="normal", text="一键做账")

    def _log(self, msg):
        try: self.log_queue.put_nowait(msg)
        except: pass


class LogPanel(ttk.LabelFrame):
    def __init__(self, parent, log_queue):
        super().__init__(parent, text="运行日志", padding=5)
        self.text = tk.Text(self, height=16, bg="#1e1e1e", fg="#d4d4d4",
                            font=("Consolas",9), wrap="word", state="disabled")
        sb = ttk.Scrollbar(self, command=self.text.yview)
        self.text.configure(yscrollcommand=sb.set)
        self.text.pack(side="left", fill="both", expand=True); sb.pack(side="right", fill="y")
        self.text.tag_configure("err", foreground="#F44747")
        self.text.tag_configure("ok", foreground="#4EC9B0")
        self.text.tag_configure("info", foreground="#9CDCFE")
        self.queue = log_queue; self._poll()

    def _poll(self):
        while not self.queue.empty():
            try:
                msg = self.queue.get_nowait()
                self.text.configure(state="normal")
                tag = "err" if "❌" in msg else ("ok" if "✅" in msg else "info")
                self.text.insert("end", msg+"\n", tag)
                self.text.see("end"); self.text.configure(state="disabled")
            except: break
        self.after(200, self._poll)


class App:
    def __init__(self, root):
        self.root = root; self.log_queue = queue.Queue(maxsize=500)
        try: self.config = load_config()
        except Exception as e: messagebox.showerror("error",str(e)); root.destroy(); return

        a = self.config.get("app",{})
        root.title(f"{a.get('name','做账')} v{a.get('version','3.3')}")
        root.geometry("1200x720"); root.minsize(950,600)

        lc = self.config.get("logging",{})
        setup_logging(log_dir=lc.get("dir","logs"), filename=lc.get("filename","reconciliation.log"),
                      level=lc.get("level","INFO"), max_bytes=lc.get("max_bytes",10485760),
                      backup_count=lc.get("backup_count",30),
                      log_format=lc.get("format","%(asctime)s | %(levelname)-8s | %(message)s"),
                      date_format=lc.get("date_format","%Y-%m-%d %H:%M:%S"), gui_queue=self.log_queue)
        self._build()

    def _build(self):
        nb = ttk.Notebook(self.root); nb.pack(fill="x", padx=15, pady=(8,5))
        oc = self.config.get("output",{})
        self.cards = {}
        for pid, pc in self.config.get("platforms",{}).items():
            card = PlatformCard(nb, pid, pc, self.log_queue, oc)
            nb.add(card, text=pc["name"])
            self.cards[pid] = card

        LogPanel(self.root, self.log_queue).pack(fill="both", expand=True, padx=15, pady=(0,8))

        bar = ttk.Frame(self.root); bar.pack(fill="x", padx=15, pady=(0,5))
        ttk.Label(bar, text="L=M+F+G+H-I-J-K | 明细Row12+ | 文件名: 2026{平台}{月}.{日}.xlsx",
                  foreground="gray").pack(side="left")

def main():
    App(tk.Tk()); tk.mainloop()

if __name__ == "__main__": main()
