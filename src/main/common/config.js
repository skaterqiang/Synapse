// 设置解析助手：从 settings 读取数值/枚举配置项，缺失或非法时回退默认值
// 说明：所有配置项由渲染层设置弹窗维护并经 IPC payload 传入，主进程不硬编码业务参数

// 数值配置：四舍五入取整并钳制到 [min, max]
function num(settings, key, def, min = 0, max = Infinity) {
  const v = Number(settings && settings[key]);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

// 枚举配置：取值不在允许列表内时回退默认
function pick(settings, key, def, allowed) {
  const v = settings && settings[key];
  return allowed.includes(v) ? v : def;
}

module.exports = { num, pick };
