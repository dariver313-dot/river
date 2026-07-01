"""配置加载器 — 加载 YAML + 替换 ${ENV_VAR} 环境变量。"""

import logging
import os
import re
from pathlib import Path
from typing import Any, Dict

import yaml
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent.parent
CONFIG_DIR = ROOT_DIR / "config"


def _resolve_env_vars(value: Any) -> Any:
    """递归替换 ${ENV_VAR} 占位符。"""
    if isinstance(value, str):
        pattern = re.compile(r"\$\{(\w+)\}")
        for var_name in pattern.findall(value):
            value = value.replace(f"${{{var_name}}}", os.environ.get(var_name, ""))
        return value
    elif isinstance(value, dict):
        return {k: _resolve_env_vars(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [_resolve_env_vars(item) for item in value]
    return value


def load_config() -> Dict:
    """加载全部配置。

    Returns:
        {
            "app": {...},
            "paths": {...},
            "output": {...},
            "logging": {...},
            "platforms": {"tianyou": {...}, "aobo": {...}, "aomen": {...}},
        }
    """
    # 1. 加载 .env
    env_path = ROOT_DIR / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    env_example = ROOT_DIR / ".env.example"
    if not env_path.exists() and env_example.exists():
        load_dotenv(env_example)

    # 2. 加载 settings.yaml
    settings_path = CONFIG_DIR / "settings.yaml"
    if not settings_path.exists():
        raise FileNotFoundError(f"配置文件不存在: {settings_path}")
    with open(settings_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    # 3. 加载 platforms.yaml
    platforms_path = CONFIG_DIR / "platforms.yaml"
    if not platforms_path.exists():
        raise FileNotFoundError(f"平台配置不存在: {platforms_path}")
    with open(platforms_path, "r", encoding="utf-8") as f:
        platforms_config = yaml.safe_load(f)
    config["platforms"] = platforms_config["platforms"]

    # 4. 替换环境变量
    config = _resolve_env_vars(config)

    logger.debug(f"配置加载完成: {len(config['platforms'])} 个平台")
    return config
