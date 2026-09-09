"""Anki 插件自有配置读写。

AI 相关配置（api_endpoint / api_key / models 等）统一由 ankifyd 的集中配置管理；
这里只保留 Anki 插件自身行为与 UI 需要的配置。
"""

ADDON_NAME = __name__.split(".")[0] if "." in __name__ else __name__

DEFAULTS = {
    "batch_size": 10,
    "dry_run": False,
    "reset_on_key_change": True,
    "source_tag": "ankify-ai::split-source",
    "locked_tag": "ankify-ai::locked",
    "exclude_decks": [],
}


def get_config():
    from aqt import mw

    cfg = mw.addonManager.getConfig(ADDON_NAME) or {}
    for key, value in DEFAULTS.items():
        cfg.setdefault(key, value)
    return cfg


def save_config(cfg):
    from aqt import mw

    mw.addonManager.writeConfig(ADDON_NAME, cfg)

