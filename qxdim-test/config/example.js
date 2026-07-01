/**
 * 配置文件示例
 * 复制此文件为 config.js 并填入你的账号信息
 * 
 * ===== 两种连接模式 =====
 * 
 * 模式1: /route 路由模式（推荐，但需要 /route 接口可用）
 *   只需填 token, userId 等基础信息
 *   程序会自动请求 /route 获取 MQTT 服务器地址
 * 
 * 模式2: 直连模式（/route 不可用时使用）
 *   需要从浏览器额外提取 MQTT 服务器地址和端口
 *   在浏览器控制台运行 scripts/extract-params.js 获取
 */

export default {
  // ===== 必填项 =====

  // 用户ID
  userId: 'YOUR_USER_ID',

  // 认证 token（从 localStorage.getItem('token') 获取）
  token: 'YOUR_ENCRYPTED_TOKEN',

  // ===== 服务器配置 =====
  serviceHost: 'qim1.qixunda.tech',
  proxyServer: 'https://qim1.qixunda.tech',

  // ===== 可选项 =====
  clientId: '',
  useWSS: true,

  // ================================================================
  // ★★★ 直连模式配置（/route 不可用时启用）★★★
  // 
  // 设置 enabled: true 后，程序将跳过 /route 请求，
  // 直接使用下面的参数连接 MQTT 服务器
  //
  // 如何获取这些参数:
  //   方法A: 在浏览器控制台运行 scripts/extract-params.js
  //   方法B: 在浏览器 Network → WS 标签查看 WebSocket URL
  //          格式: mqtts://HOST:PORT
  //   方法C: 从浏览器控制台手动提取:
  //          localStorage.getItem('token')     → token
  //          然后在 Network 刷新页面观察 WS 连接
  // ================================================================
  directConnect: {
    enabled: false,        // ★ 设为 true 启用直连模式
    
    // MQTT 服务器地址（从浏览器 WebSocket 连接中获取）
    // 例如: "192.168.1.100" 或 "mqtt.example.com"
    mqttHost: '',
    
    // MQTT 服务器端口（通常是 443 或 8084）
    mqttPort: 0,
    
    // privateSecret（可选，如果不填会自动从 token 解密）
    // 从浏览器控制台: 搜索 window 上的 privateSecret 属性
    privateSecret: '',
    
    // MQTT 密码（可选，如果不填会自动构建）
    mqttPasswordBase64: '',
    
    // node 值（可选，从 /route 响应获取，或留空）
    node: '',
  },
};
