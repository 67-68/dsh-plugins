#!/usr/bin/env python3
# @raycast.schemaVersion 1
# @raycast.title Srun Login
# @raycast.mode compact
# @raycast.packageName Network
# @raycast.icon 🔌

import configparser
import os
import sys

CONFIG_DIR = os.path.expanduser("~/.config/srun-login")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.ini")

sys.path.insert(0, CONFIG_DIR)


def main():
    cfg = configparser.ConfigParser(interpolation=None)
    if not os.path.isfile(CONFIG_PATH):
        print("❌ 未找到配置文件 " + CONFIG_PATH)
        return 1
    try:
        cfg.read(CONFIG_PATH, encoding="utf-8")
        host = cfg.get("portal", "host").strip()
        ac_id = cfg.get("portal", "ac_id").strip()
        username = cfg.get("account", "username").strip()
        password = cfg.get("account", "password")
    except Exception as exc:
        print("❌ 读取配置失败: %s" % exc)
        return 1

    if not username or username == "YOUR_USERNAME" or not password or password == "YOUR_PASSWORD":
        print("❌ 请先编辑 " + CONFIG_PATH + " 填入用户名和密码")
        return 1

    try:
        import srun
    except Exception as exc:
        print("❌ 无法加载 srun 库: %s" % exc)
        return 1

    try:
        if srun.check_connectivity(host):
            print("✅ 已在线")
            return 0
        result = srun.login(host, ac_id, username, password)
    except Exception as exc:
        srun._log_exc("srun-login")
        print("❌ %s" % exc)
        return 1

    if result.get("ok"):
        print("✅ 已登录")
        return 0
    print("❌ %s" % result.get("msg", "未知错误"))
    return 1


if __name__ == "__main__":
    sys.exit(main())
