// 渲染进程·入口：事件绑定与初始化装配
// ================= 事件绑定 =================
function bindEvents() {
  // 新建 / 删除 / 置顶 / 导出
  $('btn-new-note').addEventListener('click', (e) => {
    e.stopPropagation(); // 避免触发「全部笔记」导航切换
    promptCreateNote(null);
  });
  // 侧边栏「全部笔记」右键：批量提取知识图谱
  $('nav-all-notes').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, [
      { label: '🕸 全部笔记提取知识图谱', action: () => notesToGraph(state.notes.slice(), '全部笔记') },
    ]);
  });
  $('btn-delete').addEventListener('click', () => { deleteNote(); });
  $('btn-pin').addEventListener('click', () => {
    const note = currentNote();
    if (!note) return;
    note.pinned = !note.pinned;
    persist();
    renderAll();
  });
  $('btn-fav').addEventListener('click', () => {
    const note = currentNote();
    if (!note) return;
    toggleFavNote(note);
  });
  // 笔记列表头部 ⭐：切换「我的收藏」筛选视图（再点回到全部笔记）
  $('btn-fav-filter').addEventListener('click', () => {
    state.view = state.view.type === 'fav' ? { type: 'all', id: null, query: '' } : { type: 'fav', id: null, query: '' };
    $('btn-fav-filter').classList.toggle('active', state.view.type === 'fav');
    renderAll();
  });
  $('btn-export').addEventListener('click', async () => {
    const note = currentNote();
    if (!note) return;
    const res = await window.kb.noteOpenFolder({ folderId: note.folderId, trashed: !!note.trashed });
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
      commitEditorText();
      updatePreview();
      renderNoteList();
      renderSidebar();
    }, 300);
  };
  $('note-title').addEventListener('input', onEdit);
  $('note-content').addEventListener('input', onEdit);
  // 预览区任务清单：点复选框即勾选/取消，并回写到正文的 - [ ] / - [x]
  $('note-preview').addEventListener('click', (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-task]');
    if (!cb) return;
    toggleTaskInContent(Number(cb.dataset.task), cb.checked);
  });
  // 编辑器元信息栏（目录徽标/标签输入框）已按用户要求移除；改归属统一走笔记卡片右键「移动到目录…」

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
  $('btn-ai-favs').addEventListener('click', showFavorites);
  $('btn-ai-help').addEventListener('click', () => openDocs());
  $('btn-docs-close').addEventListener('click', () => { $('docs-view').hidden = true; });
  $('btn-ai-view-send').addEventListener('click', sendAiViewQuestion);
  // 空态示例问题：点击即作为问题直接发送（去掉装饰引号）
  $('ai-view-welcome').addEventListener('click', (e) => {
    const ex = e.target.closest && e.target.closest('.ai-welcome-card .ex');
    if (!ex) return;
    const q = (ex.textContent || '').replace(/^[“”"]+|[“”"]+$/g, '').trim();
    if (q) sendAiViewQuestion(q);
  });
  // 📎 上传文件：仅作为本次提问的上文，不写入知识库
  $('btn-ai-attach').addEventListener('click', pickAiAttachments);
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
  $('ai-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendAiQuestion();
  });

  // 设置（主区域 Tab 页）
  $('btn-settings').addEventListener('click', showSettingsView);
  // 拦截外部链接，防止整窗导航白屏
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    // 使用手册页内的链接由 docs-view 自行处理（应用内翻页/锚点/外链）
    if (a.closest('#docs-view')) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^https?:\/\//i.test(href)) { if (window.kb.openExternal) window.kb.openExternal(href); return; }
    if (window.kb.openExternal) window.kb.openExternal(href);
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
  // MinerU：解析方式切换即时反馈（自动保存由 settings-view change 委派处理）；测试按钮实际跑一次样本转换
  $('set-minerumode-builtin').addEventListener('change', applyMineruModeUI);
  $('set-minerumode-mineru').addEventListener('change', applyMineruModeUI);
  $('btn-test-mineru').addEventListener('click', testMineruConfig);
  $('btn-install-mineru').addEventListener('click', installMineruAuto);
  $('btn-mineru-apply-model').addEventListener('click', applyMineruModelSelection);
  $('btn-upload-mineru-pdf').addEventListener('click', pickMineruTestPdf);
  $('mineru-test-file').addEventListener('change', onMineruTestFilePicked);
  $('btn-open-testdir').addEventListener('click', openMineruTestDir);
  $('set-provider').addEventListener('change', applyProviderPreset);
  $('btn-fetch-models').addEventListener('click', fetchMainModels);
  // 默认模型卡底部「保存修改」（字段节点在卡片间复用，绑定一次全生命周期有效）
  $('btn-save-primary-model').addEventListener('click', () => {
    saveSettingsFields();
    renderModelList();
    toast('已保存默认模型修改', 2500);
  });
  // 模型名称输入框右侧 ▾：下拉列出全部已获取模型（原生 datalist 会按当前值过滤）
  bindModelDropdown('model-options', 'btn-model-dd', 'model-dd', 'set-model');
  $('btn-mcp-add').addEventListener('click', () => extAddRow('mcp'));
  $('btn-mcp-json-save').addEventListener('click', saveMcpJson);
  $('btn-mcp-json-cancel').addEventListener('click', () => { $('mcp-json-modal').hidden = true; });
  $('btn-skill-add').addEventListener('click', addSkillByDir);
  $('btn-skill-install').addEventListener('click', openSkillInstall);
  $('btn-skill-install-go').addEventListener('click', runSkillInstall);
  $('btn-skill-install-cancel').addEventListener('click', () => { $('skill-install-modal').hidden = true; });
  $('skill-install-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSkillInstall(); });
  $('btn-skill-edit-save').addEventListener('click', saveSkillEdit);
  $('btn-skill-edit-cancel').addEventListener('click', () => { $('skill-edit-modal').hidden = true; });
  $('btn-skill-edit-opendir').addEventListener('click', openSkillEditDir);
  $('skill-search').addEventListener('input', renderSkillGrid);
  $('settings-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchSettingsTab(btn.dataset.tab);
  });

  // 编辑器工具栏按钮统一在此绑定
  $('btn-ai-assist').addEventListener('click', aiAssistNote);
  $('btn-versions').addEventListener('click', openVersionsDrawer);
  // AI 优化进度弹窗：停止 / 关闭 / 手动滚动暂停自动跟随
  $('btn-ai-assist-stop').addEventListener('click', stopAiAssist);
  $('btn-ai-assist-close').addEventListener('click', closeAiAssistModal);
  $('ai-assist-body').addEventListener('scroll', () => {
    const box = $('ai-assist-body');
    aiAssistAutoScroll = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
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
  $('jobs-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    state.jobsFilter = btn.dataset.filter;
    renderJobsView();
  });

  // AI 数据源多选
  loadAiSources();
  loadAiGraphScopes(); // 图谱源范围（两级：体系 → 具体知识图谱，'all' 或多选）
  loadAiExt();
  loadAiModel();
  loadAiHistory();
  bindAiSources();
  applyAiSources();
  bindSetupChecklist();
  // 知识源清单以主进程注册表为准（新接入的源会自动出现在选择条上）
  loadKnowledgeSourceDefs();

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
  state.trashedFolders = store.trashedFolders || [];

  // 首次使用生成示例笔记：仅当磁盘确实没有任何笔记文件时才种子，
  // 防止瞬时异常读到空列表时误种子并回写，触发磁盘笔记清理
  if (state.notes.length === 0 && !store.hasAnyNoteFile) {
    state.notes.push({
      id: uid(),
      title: '👋 欢迎使用个人知识库助手',
      content: [
        'Synapse 是一款**本地个人知识库助手**，围绕 Markdown 笔记、原始文件、领域模板与知识图谱构建。所有数据都保存在本地（SQLite + Markdown 文件），隐私可控。',
        '',
        '## 快速上手',
        '',
        '- **新建笔记**：左上角「＋ 新建」按钮，或快捷键 `Ctrl + N`',
        '- **搜索**：左侧搜索框，或快捷键 `Ctrl + F`，支持笔记 / 原始文件 / 图谱统一检索',
        '- **目录与标签**：左侧可创建多级目录（支持折叠 / 展开）；标签在笔记元信息栏中用逗号分隔填写',
        '- **编辑模式**：工具栏可切换 编辑 / 分屏 / 预览 三种模式，默认模式可在「设置 → 编辑器」中调整',
        '- **右键即入口**：笔记卡片、原始文件、目录均可**右键**提取知识图谱；原始文件还可直接提取为笔记',
        '',
        '',
        '## 🪐 知识图谱：让知识连接可见',
        '',
        '- **右键**笔记或原始文件选择「提取知识图谱」，AI 自动抽取实体与概念及其关系',
        '- 知识图谱区块包含：🧭 概览、📍 实体浏览、🪐 整体图谱、📘 本体定义、💬 KG 问答',
        '- 支持基于图谱的知识问答，直接问「XX 和 YY 有什么关系」试试',
        '',
        '## ⚙ 作业与提示词',
        '',
        '- **作业管理**：图谱提取任务进入后台作业队列，可实时查看阶段进度，支持中断、恢复与重试',
        '- **提示词管理**：可定制 AI 辅助、问答、领域模板和图谱抽取等环节的系统提示词',
        '',
        '## 🤖 AI 智能问答',
        '',
        '点击左下角 **✨ AI 问答** 打开对话面板。在 **⚙ 设置** 中配置任意兼容 OpenAI 格式的接口（如通义千问 DashScope、DeepSeek、Ollama 本地模型等）。面板内可勾选笔记、原始文件和知识图谱作为回答依据。',
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
        '- `knowledge.db` — 目录 / 设置 / 领域模板 / 作业历史等元数据',
        '- `note/` — 笔记内容（Markdown 文件，按目录结构存放，git 友好）',
        '- `assets/` — 笔记附件（图片等）',
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
  try { state.folderCollapsed = JSON.parse(localStorage.getItem('kb.folderCollapsed') || '{}') || {}; } catch (_) { state.folderCollapsed = {}; }
  syncSidebarVisibility();
  initResizers();
  // 默认编辑器模式读设置（缺省预览：点击笔记默认以预览方式呈现）
  state.editorMode = EDITOR_MODES.includes(state.settings.defaultEditorMode) ? state.settings.defaultEditorMode : 'preview';
  // 预选一篇笔记：首页虽然是 AI 问答，但之后点「全部笔记」能直接看到内容而不是空白
  if (state.notes.length) state.selectedNoteId = getFilteredNotes()[0]?.id || state.notes[0].id;
  renderAll();
  loadGraph();
  loadTemplates();
  loadRaws();
  window.kb.onJobsUpdate(handleJobsUpdate);
  bindJobsLog();
  window.kb.jobsList().then((list) => { state.jobs = list || []; renderJobs(); });
  // 系统首页：主区域直接落在 AI 问答页
  showAiView();
}

init();
