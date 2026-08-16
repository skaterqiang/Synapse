// 应用级默认值单一配置源：默认模型等全局默认只在此处定义
// 主进程经 require 引用；渲染层经 preload 暴露的 window.kb.defaults 引用
const DEFAULTS = {
  model: 'qwen3.8-max',
  apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

// 历史错误默认值（曾短暂使用），命中时归一到当前默认
const LEGACY_MODELS = ['qianwen3.8-max'];

// 模型名归一：未设置或命中历史错误值时回退当前默认
function normalizeModel(model) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m || LEGACY_MODELS.includes(m)) return DEFAULTS.model;
  return m;
}

module.exports = { DEFAULTS, normalizeModel };
