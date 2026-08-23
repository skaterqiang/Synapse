// 渲染进程·入口：事件绑定与初始化装配
// ================= 事件绑定 =================
function bindEvents() {
  // 新建 / 删除 / 置顶 / 导出
  $('btn-new-note').addEventListener('click', (e) => {
    e.stopPropagation(); // 避免触发「全部笔记」导航切换
    promptCreateNote(null);
  });
  // 侧边栏「全部笔记」右键：全部笔记提取 Wiki / 知识图谱（按钮入口已统一为右键）
  $('nav-all-notes').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, [
      { label: '📝 全部笔记提取 Wiki', action: () => notesToWiki(state.notes.slice(), '全部笔记', '全部笔记') },
      { label: '🕸 全部笔记提取知识图谱', action: () => notesToGraph(state.notes.slice(), '全部笔记') },
    ]);
  });
  $('btn-delete').addEventListener('click', deleteNote);
  $('btn-pin').addEventListener('click', () => {
    const note = currentNote();
    if (!note) return;
    note.pinned = !note.pinned;
    persist();
    renderAll();
  });
  $('btn-export').addEventListener('click', async () => {
    const note = currentNote();
    if (!note) return;
    const res = await window.kb.noteOpenFolder({ folderId: note.folderId });
    if (!res.ok) toast('无法打开文件夹：' + (res.error || '未知错误'), 3000);
  });

  // 全部笔记
  $('nav-all-notes').addEventListener('click', () => {
    state.view = { type: 'all', id: null, query: '' };
    $('search-input').value = '';
    hideMainViews();
    // 列表被收起时，点击“全部笔记”重新展开列表
    if (state.noteListHidden) setNoteListHidden(false);
    renderAll();
  });

  // 新建目录
  $('btn-add-folder').addEventListener('click', async () => {
    const name = await askInput('新目录名称：');
    if (!name || !name.trim()) return;
    state.folders.push({ id: uid(), name: name.trim(), parentId: null });
    persist();
    renderAll();
  });

  // 搜索
  $('search-input').addEventListener('input', (e) => {
    const q = e.target.value;
    state.view = q.trim()
      ? { type: 'search', id: null, query: q.trim() }
      : { type: 'all', id: null, query: '' };
    if (q.trim() && state.noteListHidden) setNoteListHidden(false);
    renderAll();
  });

  // 编辑区输入（防抖更新）
  let editTimer = null;
  const onEdit = () => {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      updateNoteFromEditor();
      updatePreview();
      renderNoteList();
      renderSidebar();
    }, 300);
  };
  $('note-title').addEventListener('input', onEdit);
  $('note-content').addEventListener('input', onEdit);
  $('note-tags').addEventListener('change', () => {
    updateNoteFromEditor();
    renderAll();
  });
  $('note-folder').addEventListener('change', () => {
    const note = currentNote();
    if (!note) return;
    note.folderId = $('note-folder').value || null;
    note.updatedAt = Date.now();
    persist();
    renderNoteList();
    renderSidebar();
  });

  // 编辑模式切换
  ['edit', 'split', 'preview'].forEach((m) => {
    $('mode-' + m).addEventListener('click', () => {
      state.editorMode = m;
      applyEditorMode();
      updatePreview();
    });
  });

  // AI 问答：点击左下入口打开主框架 AI 页
  $('btn-ai-toggle').addEventListener('click', () => { showAiView(); });
  $('btn-ai-close').addEventListener('click', () => { setAiPanelVisible(false); });
  $('btn-ai-clear').addEventListener('click', () => {
    aiHistory = [];
    saveAiHistory();
    $('ai-messages').innerHTML = '';
  });
  $('btn-ai-send').addEventListener('click', sendAiQuestion);
  initAiPanelResize();
  bindAiExtPicker();
  // AI 主框架页
  $('btn-ai-newtask').addEventListener('click', aiNewTask);
  $('btn-ai-view-send').addEventListener('click', sendAiViewQuestion);
  // 📎 上传文件：仅作为本次提问的上文，不写入知识库
  $('btn-ai-attach').addEventListener('click', pickAiAttachments);
  bindAiExtPicker('btn-ai-src', 'ai-menu-src', ['sources']);
  bindAiExtPicker('btn-ai-mcp', 'ai-menu-mcp', ['mcp']);
  bindAiExtPicker('btn-ai-skill', 'ai-menu-skill', ['skills']);
  bindAiModelPicker();
  // 模型卡片（设置→模型配置）：新增直接追加一张卡，编辑在卡内完成
  $('btn-model-add').addEventListener('click', addModelCard);
  $('ai-view-input').addEventListener('keydown', (e) => {
    // 中文/日文等 IME 候选选词的回车会触发 keydown（isComposing===true 或 keyCode===229），
    // 只有当前未处于输入法拼写阶段时才发送，避免选词回车误发
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendAiViewQuestion();
  });
  $('ai-view-suggest').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-q]'); if (!b) return;
    $('ai-view-input').value = b.dataset.q;
    $('ai-view-input').focus();
  });
  $('ai-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendAiQuestion();
  });

  // 设置（主区域 Tab 页）
  $('btn-settings').addEventListener('click', showSettingsView);
  // 拦截所有链接点击：http 用系统浏览器打开，内部路径走 Wiki，防止整窗导航白屏
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^https?:\/\//i.test(href)) { if (window.kb.openExternal) window.kb.openExternal(href); return; }
    if (typeof openWikiPage === 'function') openWikiPage(href.replace(/^\//, ''));
  }, true);
  $('btn-notelist-hide').addEventListener('click', () => setNoteListHidden(true));
  $('btn-notelist-show').addEventListener('click', () => setNoteListHidden(false));
  $('btn-sidebar-hide').addEventListener('click', () => setSidebarHidden(true));
  $('btn-sidebar-show').addEventListener('click', () => setSidebarHidden(false));
  // 图标栏：点击派发到对应导航项，避免重复一份点击逻辑
  $('sidebar-rail').addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-btn[data-click]');
    if (!btn) return;
    const target = document.querySelector(btn.dataset.click);
    if (target) target.click();
  });
  $('btn-settings-close').addEventListener('click', hideSettingsView);
  // 设置表单自动保存：委派监听 set-* 字段的 change（失焦/提交时触发）；
  // 数据根目录与数据文件位置会迁移数据，排除在外，改由各自的「应用」按钮触发
  $('settings-view').addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.id || t.id.indexOf('set-') !== 0) return;
    if (t.id === 'set-dataroot' || t.id === 'set-dbpath') return;
    saveSettingsFields();
  });
  $('btn-apply-dataroot').addEventListener('click', applyDataRoot);
  $('btn-apply-dbpath').addEventListener('click', applyDbPath);
  $('set-provider').addEventListener('change', applyProviderPreset);
  $('btn-fetch-models').addEventListener('click', fetchMainModels);
  // 模型名称输入框右侧 ▾：下拉列出全部已获取模型（原生 datalist 会按当前值过滤）
  bindModelDropdown('model-options', 'btn-model-dd', 'model-dd', 'set-model');
  $('btn-mcp-add').addEventListener('click', () => extAddRow('mcp'));
  $('btn-mcp-json-save').addEventListener('click', saveMcpJson);
  $('btn-mcp-json-cancel').addEventListener('click', () => { $('mcp-json-modal').hidden = true; });
  $('btn-skill-add').addEventListener('click', addSkillByDir);
  $('btn-skill-edit-save').addEventListener('click', saveSkillEdit);
  $('btn-skill-edit-cancel').addEventListener('click', () => { $('skill-edit-modal').hidden = true; });
  $('skill-search').addEventListener('input', renderSkillGrid);
  $('settings-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchSettingsTab(btn.dataset.tab);
  });

  // ---------- LLM Wiki ----------
  $('wiki-header').addEventListener('click', (e) => {
    if (e.target.closest('#btn-wiki-ingest')) return; // ＋ 按钮不触发列表切换
    // 点击标题：在中间列表区按索引展示全部 Wiki 页面
    state.view = { type: 'wiki', id: null, query: '' };
    $('search-input').value = '';
    // 主内容区已开的专题页一并让位，否则作业/图谱等页会留在右侧
    hideMainViews({ keepWikiViewer: true });
    if (state.noteListHidden) setNoteListHidden(false);
    renderAll();
  });
  $('btn-wiki-ingest').addEventListener('click', openIngestModal);
  $('btn-wiki-close').addEventListener('click', closeWikiViewer);
  $('btn-wiki-source').addEventListener('click', () => {
    const body = $('wiki-body');
    const raw = $('wiki-raw-text');
    const showRaw = body.hidden === false;
    body.hidden = showRaw;
    raw.hidden = !showRaw;
  });
  // Wiki 页面内部 md 链接导航
  $('wiki-body').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.endsWith('.md')) return;
    e.preventDefault();
    openWikiPage(resolveWikiPath(state.wikiPage || '', href));
  });

  // 吸收弹窗
  $('ingest-tab-url').addEventListener('click', () => switchIngestTab('url'));
  $('ingest-tab-text').addEventListener('click', () => switchIngestTab('text'));
  $('ingest-tab-files').addEventListener('click', () => switchIngestTab('files'));
  $('btn-pick-files').addEventListener('click', async () => {
    const res = await window.kb.wikiPickFiles();
    if (res && res.ok && res.paths.length) addIngestFiles(res.paths);
  });
  // 拖拽上传：拖到弹窗任意位置均可
  const modal = $('ingest-modal');
  ['dragenter', 'dragover'].forEach((evt) => {
    modal.addEventListener(evt, (e) => {
      e.preventDefault();
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
        if (state.ingestTab !== 'files') switchIngestTab('files');
        $('file-drop').classList.add('dragover');
      }
    });
  });
  modal.addEventListener('dragleave', (e) => {
    if (e.target === modal) $('file-drop').classList.remove('dragover');
  });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    $('file-drop').classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) {
      if (state.ingestTab !== 'files') switchIngestTab('files');
      addIngestFiles(paths);
    }
  });
  $('btn-ingest-go').addEventListener('click', runIngest);
  $('btn-ingest-cancel').addEventListener('click', () => { $('ingest-modal').hidden = true; });
  $('ingest-modal').addEventListener('click', (e) => {
    if (e.target === $('ingest-modal')) $('ingest-modal').hidden = true;
  });

  // Lint 弹窗
  $('btn-lint-close').addEventListener('click', () => { $('lint-modal').hidden = true; });
  $('lint-modal').addEventListener('click', (e) => {
    if (e.target === $('lint-modal')) $('lint-modal').hidden = true;
  });

  // 作业管理页
  $('nav-jobs').addEventListener('click', showJobsView);
  $('btn-jobs-close').addEventListener('click', hideJobsView);
  // 提示词管理页
  $('nav-prompts').addEventListener('click', showPromptsView);
  $('btn-prompts-close').addEventListener('click', hidePromptsView);
  // 提示词全屏编辑页（从卡片列表进入）
  $('btn-prompt-editor-save').addEventListener('click', () => closePromptEditor(true));
  $('btn-prompt-editor-close').addEventListener('click', () => closePromptEditor(false));
  $('btn-prompt-editor-reset').addEventListener('click', resetPromptEditor);
  $('btn-jobs-new-lint').addEventListener('click', runLint);
  $('btn-jobs-clear').addEventListener('click', clearJobsHistory);
  $('jobs-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    state.jobsFilter = btn.dataset.filter;
    renderJobsView();
  });

  // AI 数据源多选
  loadAiSources();
  loadAiExt();
  loadAiModel();
  loadAiHistory();
  bindAiSources();
  applyAiSources();

  // 快捷键：Ctrl+N 新建，Ctrl+F 聚焦搜索
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createNote();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-input').focus();
    }
  });
}

// ================= 初始化 =================
async function init() {
  marked.setOptions({ breaks: true, gfm: true });
  const store = await window.kb.loadData();
  state.folders = store.folders || [];
  state.notes = store.notes || [];
  state.settings = store.settings || {};

  // 首次使用生成示例笔记
  if (state.notes.length === 0) {
    state.notes.push({
      id: uid(),
      title: '👋 欢迎使用个人知识库助手',
      content: [
        'Synapse 是一款**本地个人知识库助手**，围绕四大能力构建：**Markdown 笔记**、**LLM Wiki 知识吸收**、**领域模板**与**知识图谱**。所有数据都保存在本地（SQLite + Markdown 文件），隐私可控。',
        '',
        '## 快速上手',
        '',
        '- **新建笔记**：左上角「＋ 新建」按钮，或快捷键 `Ctrl + N`',
        '- **搜索**：左侧搜索框，或快捷键 `Ctrl + F`，支持笔记 / 原始文件 / Wiki / 图谱统一检索',
        '- **目录与标签**：左侧可创建多级目录；标签在笔记元信息栏中用逗号分隔填写',
        '- **编辑模式**：工具栏可切换 编辑 / 分屏 / 预览 三种模式，默认模式可在「设置 → 编辑器」中调整',
        '- **右键即入口**：笔记卡片、原始文件、目录均可**右键**触发「提取 Wiki / 提取知识图谱」；右键侧边栏「全部笔记」可一键批量提取全部笔记',
        '',
        '## 📖 LLM Wiki：把任意资料吸收成结构化知识',
        '',
        '1. 在「🗄 原始文件」页导入网页、PDF、Word、Excel、PPT、Markdown 等资料（支持粘贴文本 / URL，也可在吸收弹窗中直接拖拽文件）',
        '2. **右键**文件或目录选择「提取 Wiki」，系统将资料吸收为概念、来源、主题、实体四类页面',
        '3. 吸收前自动**领域预检查**：命中已有领域模板则直接套用；未命中会弹窗询问——确定后自动打开「新建领域模板」，AI 归纳领域名称并自动生成全部字段，你审阅后点「创建」即继续提取；取消则使用通用模板',
        '4. 在「📖 LLM Wiki」页浏览知识，支持 Wiki 问答与 Wiki 体检（一致性检查）',
        '',
        '## 🪐 知识图谱：让知识连接可见',
        '',
        '- **右键**笔记或原始文件选择「提取知识图谱」，AI 自动抽取实体与概念及其关系',
        '- 知识图谱区块包含：🧭 概览、📍 实体浏览、🪐 整体图谱、📘 本体定义、💬 KG 问答',
        '- 支持基于图谱的知识问答，直接问「XX 和 YY 有什么关系」试试',
        '',
        '## ⚙ 作业与提示词',
        '',
        '- **作业管理**：所有提取 / 体检任务进入串行作业队列，可实时查看阶段进度，支持中断、恢复与重试',
        '- **提示词管理**：可定制各领域模板生成、Wiki 吸收、图谱抽取等环节的系统提示词，让 AI 更懂你的领域',
        '',
        '## 🤖 AI 智能问答',
        '',
        '点击左下角 **✨ AI 问答** 打开对话面板。在 **⚙ 设置** 中配置任意兼容 OpenAI 格式的接口（如通义千问 DashScope、DeepSeek、Ollama 本地模型等）。面板内可勾选数据源组合（笔记 / LLM Wiki / 知识图谱），AI 将基于所选数据源回答你的问题。',
        '',
        '## Markdown 语法示例',
        '',
        '1. 有序列表',
        '- 无序列表',
        '',
        '> 引用块效果',
        '',
        '```js',
        'console.log("代码块高亮");',
        '```',
        '',
        '## 数据存储',
        '',
        '所有数据保存在统一数据根目录（默认 `data/`，可在「设置 → 存储」中迁移）：',
        '',
        '- `knowledge.db` — 笔记 / 目录 / 设置 / 领域模板 / 作业历史',
        '- `assets/` — 笔记附件（图片等）',
        '- `llmwiki/` — LLM Wiki 内容（Markdown 文件，git 友好）',
      ].join('\n'),
      tags: ['指南'],
      folderId: null,
      pinned: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    persist();
  }

  bindEvents();
  bindEditorToolbar();
  bindGraphEvents();
  bindTplEvents();
  bindRawEvents();
  state.noteListHidden = localStorage.getItem('kb.noteListHidden') === '1';
  state.sidebarHidden = localStorage.getItem('kb.sidebarHidden') === '1';
  syncSidebarVisibility();
  initResizers();
  // 默认编辑器模式读设置（缺省分屏）
  state.editorMode = EDITOR_MODES.includes(state.settings.defaultEditorMode) ? state.settings.defaultEditorMode : 'split';
  renderAll();
  loadWiki();
  loadGraph();
  loadTemplates();
  loadRaws();
  window.kb.onJobsUpdate(handleJobsUpdate);
  window.kb.jobsList().then((list) => { state.jobs = list || []; renderJobs(); });
  if (state.notes.length) selectNote(getFilteredNotes()[0]?.id || state.notes[0].id);
}

init();
