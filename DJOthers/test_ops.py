import requests
import json

# ==================== 1. 请在此处填写你的真实配置 ====================
WEBSITES = [
    "amam2009.com",  # 拿百度做测试，它在国内肯定 100% 连通
    "c2009c.com"   # 拿谷歌做测试，它在国内肯定 100% 被墙
]

# 你的 DeepSeek 开放平台 API 密钥
DEEPSEEK_API_KEY = "YOUR_API_KEY_HERE"

# 你的 Telegram 机器人参数
TG_BOT_TOKEN = "8495920166:AAFiANjQu6ImzrSWj6HTuIodr-Hg2CIxCeg"
TG_CHAT_ID = "8373296041"
# ============================================================


# 🔄 修复点 1：ITDOG 的公共 HTTP 测试节点 API 地址修正
def check_china_network(url):
    print(f"正在调动国内节点拨测: {url}...")
    try:
        api_url = f"https://itdog.cn"
        payload = {"url": url, "zone": "china"}
        response = requests.post(api_url, json=payload, timeout=15)
        # 截取前3000个字符，防止节点返回的原始数据太长塞满大模型
        return response.text[:3000] 
    except Exception as e:
        return f"拨测接口调用失败: {str(e)}"


# 🔄 修复点 2：DeepSeek 官方 API 请求地址修正为 ://deepseek.com
def ask_deepseek(raw_data):
    print("正在请求 DeepSeek 帮你分析数据...")
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json"
    }
    prompt = f"""
    你是一个极其专业的网络运维专家。
    请用最通俗易懂的大白话，为老板写一份每日简报。
    必须明确指出：哪些网站在国内打不开（被墙/拦截）、哪些网站正常。
    为了方便在手机Telegram上阅读，多用换行和 emoji 序号（如 1️⃣、2️⃣、🚨、✅），字数控制在400字内。
    
    原始数据：
    {raw_data}
    """
    payload = {
        "model": "deepseek-chat", # 调用 DeepSeek-V3/V4 旗舰模型
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3
    }
    try:
        res = requests.post("https://api.deepseek.com/v1/chat/completions", headers=headers, json=payload)
        res.raise_for_status()
        return res.json()['choices'][0]['message']['content']
    except Exception as e:
        return f"DeepSeek 思考失败: {str(e)}"


# 🔄 修复点 3：Telegram 官方发送消息的接口地址修正
def send_telegram_message(content):
    print("正在通过网络向你的 Telegram 发送通知...")
    # 官方正确域名是 api.telegram.org，且必须带有 /bot 前缀
    tg_url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"

    payload = {
        "chat_id": TG_CHAT_ID,
        "text": content,
        "parse_mode": "Markdown" 
    }
    try:
        res = requests.post(tg_url, json=payload, timeout=15)
        if res.status_code == 200:
            print("==== 🎉 测试成功！报告已经发到你的手机 Telegram 上了！ ====")
        else:
            print(f"Telegram 发送失败，代码: {res.status_code}, 原因: {res.text}")
    except Exception as e:
        print(f"连接 Telegram 失败: {str(e)}")


if __name__ == "__main__":
    all_reports = ""
    for site in WEBSITES:
        china_data = check_china_network(site)
        all_reports += f"\n--- 站点: {site} 的全国数据汇总 ---\n{china_data}\n"
    
    ai_analysis_result = ask_deepseek(all_reports)
    send_telegram_message(ai_analysis_result)
    input("\n按回车键退出...") # 保证黑窗口不闪退，方便看报错
