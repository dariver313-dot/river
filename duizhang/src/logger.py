"""日志系统。

- 文件日志：按天轮转，保留30天
- GUI 日志：同时输出到 tkinter Text 组件
"""

import logging
import logging.handlers
import queue
from pathlib import Path
from typing import Optional


class GuiLogHandler(logging.Handler):
    """将日志发送到 tkinter Text 组件的 handler。

    通过队列线程安全地传递日志消息到 GUI。
    """

    def __init__(self, log_queue: queue.Queue):
        super().__init__()
        self.log_queue = log_queue
        self.setFormatter(logging.Formatter(
            "%(asctime)s | %(levelname)-8s | %(message)s",
            datefmt="%H:%M:%S"
        ))

    def emit(self, record):
        msg = self.format(record)
        try:
            self.log_queue.put_nowait(msg)
        except queue.Full:
            pass  # 队列满了就丢弃，不阻塞


def setup_logging(
    log_dir: str = "logs",
    filename: str = "reconciliation.log",
    level: str = "INFO",
    max_bytes: int = 10 * 1024 * 1024,
    backup_count: int = 30,
    log_format: str = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    date_format: str = "%Y-%m-%d %H:%M:%S",
    gui_queue: Optional[queue.Queue] = None,
) -> logging.Logger:
    """配置日志系统。

    Args:
        log_dir: 日志目录
        filename: 日志文件名
        level: 日志级别
        max_bytes: 单文件最大字节数
        backup_count: 保留备份文件数
        log_format: 日志格式
        date_format: 时间格式
        gui_queue: 可选，传入则同时输出到 GUI

    Returns:
        根 logger
    """
    # 确保日志目录存在
    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)

    # 根 logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    # 清除已有的 handler（避免重复）
    root_logger.handlers.clear()

    # 文件 handler（按大小轮转）
    file_handler = logging.handlers.RotatingFileHandler(
        log_path / filename,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(log_format, datefmt=date_format))
    root_logger.addHandler(file_handler)

    # 控制台 handler（开发调试用）
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(logging.Formatter(log_format, datefmt=date_format))
    root_logger.addHandler(console_handler)

    # GUI handler（可选）
    if gui_queue is not None:
        gui_handler = GuiLogHandler(gui_queue)
        gui_handler.setLevel(logging.INFO)
        root_logger.addHandler(gui_handler)

    logger = logging.getLogger(__name__)
    logger.info(f"日志系统初始化: level={level}, dir={log_dir}")

    return root_logger
