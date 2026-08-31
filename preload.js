const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kb', {
  // 运行环境标识（渲染层据此区分桌面/Web 分支；Web 模式由 web/kb-shim.js 置 false）
  isElectron: true,
  // 应用级默认值（单一配置源 defaults.js，供渲染层展示占位与兜底）
  defaults: require('./src/main/ai/defaults').DEFAULTS,
  // 模型名归一：未设置/历史错误值 → 当前默认（与主进程同一实现）
  normalizeModel: require('./src/main/ai/defaults').normalizeModel,
  // 数据
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (store) => ipcRenderer.invoke('data:save', store),
  setDbPath: (p) => ipcRenderer.invoke('data:setDbPath', p),

  // AI 问答（流式）
  askAI: (payload) => ipcRenderer.invoke('ai:ask', payload),
  // 停止当前回答（回答中时发送按钮变为“停止”）
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  // 列出接口可用模型（设置页「获取模型」）
  listModels: (settings) => ipcRenderer.invoke('ai:listModels', settings),
  onAiChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('ai:chunk', handler);
    return () => ipcRenderer.removeListener('ai:chunk', handler);
  },
  onAiDone: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('ai:done', handler);
    return () => ipcRenderer.removeListener('ai:done', handler);
  },
  onAiError: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('ai:error', handler);
    return () => ipcRenderer.removeListener('ai:error', handler);
  },
  onAiStep: (callback) => {
    const handler = (_event, step) => callback(step);
    ipcRenderer.on('ai:step', handler);
    return () => ipcRenderer.removeListener('ai:step', handler);
  },

  // 领域模版 AI 生成：流式增量（{ text, reasoning }），供弹窗实时打印生成过程
  onTplGenChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('tpl:gen-chunk', handler);
    return () => ipcRenderer.removeListener('tpl:gen-chunk', handler);
  },
  onTplMatchChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('tpl:match-chunk', handler);
    return () => ipcRenderer.removeListener('tpl:match-chunk', handler);
  },
  onTplSuggestProfileChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('tpl:suggest-profile-chunk', handler);
    return () => ipcRenderer.removeListener('tpl:suggest-profile-chunk', handler);
  },
  // AI 问答引用事件：知识检索完成后一次回传 笔记/图谱/原始文件 引用（与 web/kb-shim.js 对齐）
  onAiRefs: (callback) => {
    const handler = (_event, refs) => callback(refs);
    ipcRenderer.on('ai:refs', handler);
    return () => ipcRenderer.removeListener('ai:refs', handler);
  },
  // 编辑器 AI 优化执行过程：流式增量 {type:'think'|'text', text}，供进度弹窗实时展示
  onAiAssistChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('ai:assist-chunk', handler);
    return () => ipcRenderer.removeListener('ai:assist-chunk', handler);
  },
  aiAssistStop: () => ipcRenderer.invoke('note:aiAssistStop'),

  // 领域模版
  tplList: () => ipcRenderer.invoke('tpl:list'),
  tplSave: (tpl) => ipcRenderer.invoke('tpl:save', tpl),
  tplRemove: (id) => ipcRenderer.invoke('tpl:remove', id),
  tplGenerate: (payload) => ipcRenderer.invoke('tpl:generate', payload),
  tplMatchPrompt: () => ipcRenderer.invoke('tpl:matchPrompt'),
  tplProfileTree: (profileId) => ipcRenderer.invoke('tpl:profileTree', profileId),
  tplMatchFor: (payload) => ipcRenderer.invoke('tpl:matchFor', payload), // 吸收前领域模板预检查
  tplSuggestName: (payload) => ipcRenderer.invoke('tpl:suggestName', payload), // 未命中后按来源内容归纳领域名称（供新建弹窗自动填充）
  tplSuggestProfile: (payload) => ipcRenderer.invoke('tpl:suggestProfile', payload), // 按来源内容实时匹配最合适的本体体系（不读模版绑定）
  promptsDefs: () => ipcRenderer.invoke('prompts:defs'),

  // 原始文件管理
  rawList: (settings) => ipcRenderer.invoke('raw:list', settings),
  // 原始文件关键字检索（作为 AI 问答知识源）
  rawSearch: (payload) => ipcRenderer.invoke('raw:search', payload),
  rawExtractNote: (payload) => ipcRenderer.invoke('raw:extractNote', payload),
  mineruTest: (payload) => ipcRenderer.invoke('mineru:test', payload),
  onMineruTestLog: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('mineru:test-log', handler);
    return () => ipcRenderer.removeListener('mineru:test-log', handler);
  },
  mineruInstall: (payload) => ipcRenderer.invoke('mineru:install', payload),
  // 应用「模型配置」里的模型到 MinerU 包装脚本
  mineruApplyModel: (payload) => ipcRenderer.invoke('mineru:apply-model', payload),
  onMineruInstallLog: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('mineru:install-log', handler);
    return () => ipcRenderer.removeListener('mineru:install-log', handler);
  },
  rawPickFiles: () => ipcRenderer.invoke('raw:pickFiles'),
  // 知识访问统一接口：源清单 + 一次性检索（各源并行，结果已归一）
  knowledgeSources: () => ipcRenderer.invoke('knowledge:sources'),
  knowledgeRetrieve: (payload) => ipcRenderer.invoke('knowledge:retrieve', payload),
  readAttachments: (payload) => ipcRenderer.invoke('ai:readAttachments', payload),
  rawAddUrl: (payload) => ipcRenderer.invoke('raw:addUrl', payload),
  rawRenameUrl: (payload) => ipcRenderer.invoke('raw:renameUrl', payload),
  skillRead: (payload) => ipcRenderer.invoke('skill:read', payload),
  skillInstall: (payload) => ipcRenderer.invoke('skill:install', payload),
  onSkillInstallLog: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('skill:install-log', handler);
    return () => ipcRenderer.removeListener('skill:install-log', handler);
  },
  chatGetHistory: () => ipcRenderer.invoke('chat:getHistory'),
  chatSaveHistory: (list) => ipcRenderer.invoke('chat:saveHistory', list),
  chatGetSessions: () => ipcRenderer.invoke('chat:getSessions'),
  chatSaveSessions: (list) => ipcRenderer.invoke('chat:saveSessions', list),
  mcpTest: (cfg) => ipcRenderer.invoke('mcp:test', cfg),
  rawPickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 技能脚本执行与本地文件打开（产物卡片用）
  skillRun: (payload) => ipcRenderer.invoke('skill:run', payload),
  openPath: (payload) => ipcRenderer.invoke('shell:openPath', payload),
  revealPath: (payload) => ipcRenderer.invoke('shell:revealPath', payload),
  readDoc: (payload) => ipcRenderer.invoke('docs:read', payload),
  rawOpen: (payload) => ipcRenderer.invoke('raw:open', payload),
  rawRemove: (payload) => ipcRenderer.invoke('raw:remove', payload),
  rawRemoveDir: (payload) => ipcRenderer.invoke('raw:removeDir', payload),
  rawAddFiles: (payload) => ipcRenderer.invoke('raw:addFiles', payload),
  rawAddDir: (payload) => ipcRenderer.invoke('raw:addDir', payload),
  browseDir: (payload) => ipcRenderer.invoke('raw:browse', payload),

  // 作业管理
  jobsList: () => ipcRenderer.invoke('jobs:list'),
  jobsSubmit: (payload) => ipcRenderer.invoke('jobs:submit', payload),
  jobsRemove: (id) => ipcRenderer.invoke('jobs:remove', id),
  jobsClear: () => ipcRenderer.invoke('jobs:clear'),
  jobsRetry: (payload) => ipcRenderer.invoke('jobs:retry', payload),
  jobsCancel: (id) => ipcRenderer.invoke('jobs:cancel', id),
  onJobsUpdate: (callback) => {
    const handler = (_event, list) => callback(list);
    ipcRenderer.on('jobs:update', handler);
    return () => ipcRenderer.removeListener('jobs:update', handler);
  },
  jobsLogs: (id) => ipcRenderer.invoke('jobs:logs', { id }),
  onJobsLog: (callback) => {
    const handler = (_event, d) => callback(d);
    ipcRenderer.on('jobs:log', handler);
    return () => ipcRenderer.removeListener('jobs:log', handler);
  },

  // 其他
  exportNote: (options) => ipcRenderer.invoke('dialog:export', options),
  getDataPath: () => ipcRenderer.invoke('app:getDataPath'),
  dataRoot: () => ipcRenderer.invoke('app:dataRoot'),
  setDataRoot: (p) => ipcRenderer.invoke('data:setRoot', p),

  // 知识图谱
  graphGet: () => ipcRenderer.invoke('graph:get'),
  graphClear: () => ipcRenderer.invoke('graph:clear'),
  graphOntology: (profileId) => ipcRenderer.invoke('graph:ontology', profileId),
  graphProfiles: () => ipcRenderer.invoke('graph:profiles'),
  graphScopes: () => ipcRenderer.invoke('graph:scopes'),
  graphResolveSources: (payload) => ipcRenderer.invoke('graph:resolveSources', payload),
  ontoSave: (payload) => ipcRenderer.invoke('onto:save', payload),
  ontoRemove: (payload) => ipcRenderer.invoke('onto:remove', payload),
  ontoSetProfile: (profileId) => ipcRenderer.invoke('onto:setProfile', profileId),
  graphAsk: (payload) => ipcRenderer.invoke('graph:ask', payload),
  graphImportOwl: (body) => ipcRenderer.invoke('graph:importOwl', body),
  graphRemoveOwlProfile: (payload) => ipcRenderer.invoke('graph:removeOwlProfile', payload),
  onKgFacts: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('kg:facts', handler);
    return () => ipcRenderer.removeListener('kg:facts', handler);
  },
  onKgStage: (callback) => {
    const handler = (_e, text) => callback(text);
    ipcRenderer.on('kg:stage', handler);
    return () => ipcRenderer.removeListener('kg:stage', handler);
  },

  // 笔记附件与 AI 扫描
  notePickImage: (opts) => ipcRenderer.invoke('note:pickImage', opts),
  noteSaveImage: (payload) => ipcRenderer.invoke('note:saveImage', payload),
  noteScan: (payload) => ipcRenderer.invoke('note:scan', payload),
  noteOpenFolder: (payload) => ipcRenderer.invoke('note:openFolder', payload),
  noteAiAssist: (payload) => ipcRenderer.invoke('note:aiAssist', payload),
  noteSaveVersion: (payload) => ipcRenderer.invoke('note:saveVersion', payload),
  noteListVersions: (payload) => ipcRenderer.invoke('note:listVersions', payload),
  noteGetVersion: (payload) => ipcRenderer.invoke('note:getVersion', payload),
  noteDeleteVersions: (payload) => ipcRenderer.invoke('note:deleteVersions', payload),
});
