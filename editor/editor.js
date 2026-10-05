/**
 * 心知 (Xinzhi) 编辑端交互脚本
 * 严格执行 HTML 安全转义 (textContent)，防范 XSS 漏洞；支持 CSRF 校验、错误反馈与响应式选项卡。
 */

(() => {
  'use strict';

  // 全局状态
  let currentSession = { authenticated: false, csrfToken: '' };
  let currentArticles = [];
  let currentEditingArticle = null;

  // DOM 元素引用
  const authStatusText = document.getElementById('authStatusText');
  const loginView = document.getElementById('loginView');
  const dashboardView = document.getElementById('dashboardView');
  const loginForm = document.getElementById('loginForm');
  const adminTokenInput = document.getElementById('adminTokenInput');
  const loginAlert = document.getElementById('loginAlert');
  const btnLogout = document.getElementById('btnLogout');
  const topNav = document.getElementById('topNav');

  // 选项卡与筛选
  const tabButtons = document.querySelectorAll('nav button[data-tab]');
  const tabPanels = {
    articles: document.getElementById('tab-articles'),
    notes: document.getElementById('tab-notes'),
    'github-library': document.getElementById('tab-github-library'),
    preview: document.getElementById('tab-preview'),
  };

  const articleSearch = document.getElementById('articleSearch');
  const statusFilter = document.getElementById('statusFilter');
  const categoryFilter = document.getElementById('categoryFilter');
  const btnRefreshArticles = document.getElementById('btnRefreshArticles');
  const articlesTbody = document.getElementById('articlesTbody');
  const articleCountText = document.getElementById('articleCountText');

  const githubLibrarySearchForm = document.getElementById('githubLibrarySearchForm');
  const githubLibraryQuery = document.getElementById('githubLibraryQuery');
  const githubLibraryLimit = document.getElementById('githubLibraryLimit');
  const githubLibraryStatus = document.getElementById('githubLibraryStatus');
  const githubLibraryMeta = document.getElementById('githubLibraryMeta');
  const githubLibraryResults = document.getElementById('githubLibraryResults');
  let githubLibraryRequest = 0;

  // 编辑弹窗
  const editModal = document.getElementById('editModal');
  const btnModalClose = document.getElementById('btnModalClose');
  const btnCancelEdit = document.getElementById('btnCancelEdit');
  const editForm = document.getElementById('editForm');
  const modalAlert = document.getElementById('modalAlert');
  const modalStatusBadge = document.getElementById('modalStatusBadge');
  const modalOrigTitle = document.getElementById('modalOrigTitle');
  const modalOrigSource = document.getElementById('modalOrigSource');
  const modalOrigDate = document.getElementById('modalOrigDate');
  const modalOrigUrl = document.getElementById('modalOrigUrl');
  const modalOrigDoi = document.getElementById('modalOrigDoi');

  const inputTitleZh = document.getElementById('inputTitleZh');
  const selectStudyType = document.getElementById('selectStudyType');
  const selectEvidenceBasis = document.getElementById('selectEvidenceBasis');
  const inputSummary = document.getElementById('inputSummary');
  const inputLimitations = document.getElementById('inputLimitations');
  const inputReviewer = document.getElementById('inputReviewer');
  const checkboxSourceChecked = document.getElementById('checkboxSourceChecked');
  const btnPublishArticle = document.getElementById('btnPublishArticle');
  const btnWithdrawArticle = document.getElementById('btnWithdrawArticle');

  // 内部共读笔记
  const noteKeyInput = document.getElementById('noteKeyInput');
  const btnLoadNote = document.getElementById('btnLoadNote');
  const noteTitleInput = document.getElementById('noteTitleInput');
  const noteReviewerInput = document.getElementById('noteReviewerInput');
  const noteContentTextarea = document.getElementById('noteContentTextarea');
  const btnSaveNote = document.getElementById('btnSaveNote');
  const notesHistoryList = document.getElementById('notesHistoryList');

  // 公开预览
  const previewDateInput = document.getElementById('previewDateInput');
  const btnRefreshPreview = document.getElementById('btnRefreshPreview');
  const previewArticlesContainer = document.getElementById('previewArticlesContainer');

  const toast = document.getElementById('toast');

  // ============================
  // 工具函数 (安全第一)
  // ============================

  function showToast(msg, duration = 3000) {
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, duration);
  }

  function showAlert(alertEl, msg, isError = true) {
    alertEl.textContent = msg;
    alertEl.className = 'alert-box ' + (isError ? 'alert-error' : 'alert-success');
    alertEl.style.display = 'block';
  }

  function hideAlert(alertEl) {
    alertEl.textContent = '';
    alertEl.style.display = 'none';
  }

  async function apiFetch(endpoint, options = {}) {
    const defaultHeaders = {
      'Content-Type': 'application/json',
    };
    if (currentSession.csrfToken) {
      defaultHeaders['X-CSRF-Token'] = currentSession.csrfToken;
    }
    options.headers = Object.assign(defaultHeaders, options.headers || {});

    try {
      const resp = await fetch(endpoint, options);
      const data = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: '网络连接错误: ' + err.message } };
    }
  }

  // ============================
  // 鉴权与会话管理
  // ============================

  async function checkSession() {
    const res = await apiFetch('/api/editor/session');
    if (res.ok && res.data.authenticated) {
      setAuthenticated(true, res.data.csrf_token);
      loadArticles();
      loadNotesHistory();
    } else {
      setAuthenticated(false);
    }
  }

  function setAuthenticated(isAuth, csrfToken = '') {
    currentSession.authenticated = isAuth;
    currentSession.csrfToken = csrfToken;

    if (isAuth) {
      authStatusText.textContent = '已登录本地编辑身份';
      loginView.style.display = 'none';
      dashboardView.style.display = 'block';
      topNav.style.display = 'flex';
      btnLogout.style.display = 'inline-block';
    } else {
      authStatusText.textContent = '未登录 · 需要本地凭证';
      loginView.style.display = 'block';
      dashboardView.style.display = 'none';
      topNav.style.display = 'none';
      btnLogout.style.display = 'none';
      githubLibraryRequest += 1;
      githubLibraryMeta.replaceChildren();
      githubLibraryMeta.hidden = true;
      githubLibraryResults.replaceChildren();
      githubLibraryStatus.textContent = '登录后可搜索私有文献库索引。';
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(loginAlert);
    const token = adminTokenInput.value.trim();
    if (!token) return;

    const res = await apiFetch('/api/editor/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    if (res.ok && res.data.ok) {
      adminTokenInput.value = '';
      setAuthenticated(true, res.data.csrf_token);
      showToast('登录成功');
      loadArticles();
      loadNotesHistory();
    } else {
      const errMsg = (res.data && res.data.error) || '登录失败，请检查口令';
      showAlert(loginAlert, errMsg, true);
    }
  });

  btnLogout.addEventListener('click', async () => {
    await apiFetch('/api/editor/logout', { method: 'POST' });
    setAuthenticated(false);
    showToast('已退出登录');
  });

  // ============================
  // 选项卡切换
  // ============================

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      Object.keys(tabPanels).forEach((k) => {
        if (tabPanels[k]) {
          tabPanels[k].style.display = k === targetTab ? 'block' : 'none';
        }
      });
      if (targetTab === 'preview') {
        initPreview();
      }
      if (targetTab === 'github-library') loadGithubLibrary();
    });
  });

  // ============================
  // GitHub 文献库：只读取已认证本地服务中的索引快照
  // ============================
  function githubRepositoryUrl(fullName, commit = '') {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName || '')) return '';
    const base = 'https://github.com/' + fullName.split('/').map(encodeURIComponent).join('/');
    return commit && /^[0-9a-f]{7,64}$/i.test(commit) ? base + '/commit/' + commit : base;
  }

  function githubLibraryDoiUrl(doi) {
    if (typeof doi !== 'string' || !/^10\.\d{4,9}\/\S+$/i.test(doi)) return '';
    return 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/');
  }

  function appendLibraryLine(container, label, value, href = '') {
    const line = document.createElement('p');
    const name = document.createElement('strong');
    name.textContent = label + '：';
    const content = document.createElement(href ? 'a' : 'span');
    content.textContent = value || '未提供';
    if (href) { content.href = href; content.target = '_blank'; content.rel = 'noopener noreferrer'; }
    line.append(name, content); container.appendChild(line);
  }

  async function loadGithubLibrary() {
    if (!currentSession.authenticated) return;
    const request = ++githubLibraryRequest;
    githubLibraryStatus.textContent = '正在读取已有文献库索引…';
    githubLibraryResults.replaceChildren();
    githubLibraryMeta.replaceChildren(); githubLibraryMeta.hidden = true;
    const query = new URLSearchParams({ q: githubLibraryQuery.value.trim(), limit: githubLibraryLimit.value });
    const res = await apiFetch('/api/editor/github-library?' + query.toString(), { cache: 'no-store' });
    if (request !== githubLibraryRequest || !currentSession.authenticated) return;
    if (res.status === 401) { setAuthenticated(false); return; }
    if (!res.ok) {
      githubLibraryStatus.textContent = res.data.error || '文献库索引暂不可用，请检查文献库维护流程。';
      return;
    }
    if (!res.data.available) {
      githubLibraryStatus.textContent = res.data.message || '还没有可检索的索引，请先完成文献库索引更新。';
      return;
    }
    const repository = res.data.repository || {};
    const snapshot = res.data.snapshot || {};
    githubLibraryMeta.hidden = false;
    appendLibraryLine(githubLibraryMeta, '私有仓库', repository.full_name, githubRepositoryUrl(repository.full_name));
    appendLibraryLine(githubLibraryMeta, '索引更新时间', snapshot.indexed_at);
    appendLibraryLine(githubLibraryMeta, '索引版本', snapshot.commit, githubRepositoryUrl(repository.full_name, snapshot.commit));
    appendLibraryLine(githubLibraryMeta, '原始索引总行数', String(res.data.source_rows ?? 0));
    const checksumCounts = res.data.checksum_counts || {};
    const count = (key) => Number.isSafeInteger(checksumCounts[key]) && checksumCounts[key] >= 0 ? checksumCounts[key] : 0;
    appendLibraryLine(githubLibraryMeta, '索引哈希记录', `格式完整 ${count('valid')} 条 · 未提供 ${count('missing')} 条 · 待核验 ${count('invalid')} 条`);
    const items = Array.isArray(res.data.items) ? res.data.items : [];
    githubLibraryStatus.textContent = items.length ? `本次显示 ${items.length} 条，最多 ${res.data.limit} 条；仅为索引题录。` : '已有快照中没有匹配的题录，请更换检索词。';
    items.forEach((paper) => {
      const card = document.createElement('article'); card.className = 'github-library-card';
      const title = document.createElement('h3'); title.textContent = paper.title || '题名待补'; card.appendChild(title);
      appendLibraryLine(card, '期刊', paper.journal);
      appendLibraryLine(card, 'DOI', paper.doi, githubLibraryDoiUrl(paper.doi));
      appendLibraryLine(card, '原索引日期', paper.source_date);
      if (paper.date_basis) appendLibraryLine(card, '日期依据', paper.date_basis);
      if (paper.pdf_sha256_status === 'invalid') {
        const warning = document.createElement('p'); warning.className = 'github-library-warning';
        warning.textContent = '索引哈希待核验；题录可检索，全文需维护者先核对。'; card.appendChild(warning);
      }
      const details = document.createElement('details'); details.className = 'github-library-location';
      const heading = document.createElement('summary'); heading.textContent = '索引记录的全文位置'; details.appendChild(heading);
      appendLibraryLine(details, '仓库相对路径', paper.relative_path);
      const explanation = document.createElement('p'); explanation.textContent = '需要全文时，由维护流程按此位置取单篇文件；页面不会自动下载。'; details.appendChild(explanation);
      card.appendChild(details);
      githubLibraryResults.appendChild(card);
    });
  }

  githubLibrarySearchForm.addEventListener('submit', (e) => { e.preventDefault(); loadGithubLibrary(); });

  // ============================
  // 候选与文章管理
  // ============================

  async function loadArticles() {
    articlesTbody.innerHTML = '';
    const loadingRow = document.createElement('tr');
    const loadingCell = document.createElement('td');
    loadingCell.colSpan = 7;
    loadingCell.className = 'empty';
    loadingCell.textContent = '正在获取文献候选...';
    loadingRow.appendChild(loadingCell);
    articlesTbody.appendChild(loadingRow);

    const statusVal = statusFilter.value;
    const catVal = categoryFilter.value;
    const searchVal = articleSearch.value.trim();

    const query = new URLSearchParams({
      status: statusVal,
      category: catVal,
      search: searchVal,
      page: '1',
      page_size: '100',
    });

    const res = await apiFetch(`/api/editor/articles?${query.toString()}`);
    articlesTbody.innerHTML = '';

    if (!res.ok) {
      const errRow = document.createElement('tr');
      const errCell = document.createElement('td');
      errCell.colSpan = 7;
      errCell.className = 'empty';
      errCell.textContent = '获取失败: ' + (res.data.error || '未知错误');
      errRow.appendChild(errCell);
      articlesTbody.appendChild(errRow);
      return;
    }

    currentArticles = res.data.items || [];
    articleCountText.textContent = `共 ${res.data.total} 篇`;

    if (currentArticles.length === 0) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = 7;
      emptyCell.className = 'empty';
      emptyCell.textContent = '暂无匹配的文献候选。可点击“刷新”或执行 import_data.py 导入。';
      emptyRow.appendChild(emptyCell);
      articlesTbody.appendChild(emptyRow);
      return;
    }

    currentArticles.forEach((art) => {
      const tr = document.createElement('tr');

      // 1. 状态 Badge
      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'badge badge-' + (art.status || 'candidate');
      const statusMap = {
        candidate: '候选',
        draft: '草稿',
        published: '已发布',
        withdrawn: '已撤回',
      };
      badge.textContent = statusMap[art.status] || art.status;
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      // 2. 题名 / 信源
      const tdTitle = document.createElement('td');
      const titleStrong = document.createElement('div');
      titleStrong.style.fontWeight = '600';
      titleStrong.textContent = art.title_zh ? art.title_zh : art.title;
      tdTitle.appendChild(titleStrong);

      if (art.title_zh) {
        const origSmall = document.createElement('div');
        origSmall.style.fontSize = '11px';
        origSmall.style.color = 'var(--muted)';
        origSmall.textContent = '原题: ' + art.title;
        tdTitle.appendChild(origSmall);
      }

      const metaSmall = document.createElement('div');
      metaSmall.style.fontSize = '11px';
      metaSmall.style.color = 'var(--muted)';
      const dateStr = (art.source_date || '').split('T')[0];
      metaSmall.textContent = `${art.source || '未知信源'} · ${dateStr}`;
      tdTitle.appendChild(metaSmall);
      tr.appendChild(tdTitle);

      // 3. 方向
      const tdCat = document.createElement('td');
      const catPill = document.createElement('span');
      catPill.className = 'pill';
      catPill.textContent = art.category || 'AI医疗';
      tdCat.appendChild(catPill);
      tr.appendChild(tdCat);

      // 4. 证据依据
      const tdEvidence = document.createElement('td');
      const basisMap = {
        index: '仅索引元数据',
        abstract: '已核对摘要',
        fulltext: '已精读全文',
      };
      tdEvidence.textContent = basisMap[art.evidence_basis] || art.evidence_basis;
      tr.appendChild(tdEvidence);

      // 5. 来源核对
      const tdChecked = document.createElement('td');
      tdChecked.textContent = art.source_checked ? '✓ 已核对' : '✗ 未核对';
      tdChecked.style.color = art.source_checked ? 'var(--teal)' : 'var(--amber)';
      tr.appendChild(tdChecked);

      // 6. 审核人
      const tdReviewer = document.createElement('td');
      tdReviewer.textContent = art.reviewer || '-';
      tr.appendChild(tdReviewer);

      // 7. 操作
      const tdOps = document.createElement('td');
      tdOps.style.textAlign = 'center';
      const btnEdit = document.createElement('button');
      btnEdit.className = 'outline';
      btnEdit.textContent = '编辑审核';
      btnEdit.addEventListener('click', () => openEditModal(art));
      tdOps.appendChild(btnEdit);
      tr.appendChild(tdOps);

      articlesTbody.appendChild(tr);
    });
  }

  btnRefreshArticles.addEventListener('click', loadArticles);
  statusFilter.addEventListener('change', loadArticles);
  categoryFilter.addEventListener('change', loadArticles);
  articleSearch.addEventListener('input', debounce(loadArticles, 300));

  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ============================
  // 编辑弹窗
  // ============================

  function openEditModal(article) {
    currentEditingArticle = article;
    hideAlert(modalAlert);

    // 填充原始只读元数据 (使用 textContent 防注入)
    modalOrigTitle.textContent = article.title;
    modalOrigSource.textContent = article.source || '未知信源';
    modalOrigDate.textContent = (article.source_date || '').split('T')[0] || '-';
    modalOrigDoi.textContent = article.doi || '无';

    if (article.url) {
      modalOrigUrl.href = article.url;
      modalOrigUrl.textContent = '访问期刊原文 ↗';
      modalOrigUrl.style.display = 'inline';
    } else {
      modalOrigUrl.style.display = 'none';
    }

    modalStatusBadge.className = 'badge badge-' + (article.status || 'candidate');
    const statusMap = {
      candidate: '候选状态',
      draft: '草稿状态',
      published: '已发布状态 (公开可见)',
      withdrawn: '已撤回状态 (公开不可见)',
    };
    modalStatusBadge.textContent = statusMap[article.status] || article.status;

    // 填充表单字段
    inputTitleZh.value = article.title_zh || '';
    selectStudyType.value = article.study_type || '';
    selectEvidenceBasis.value = article.evidence_basis || 'index';
    inputSummary.value = article.summary || '';
    inputLimitations.value = article.limitations || '';
    inputReviewer.value = article.reviewer || '';
    checkboxSourceChecked.checked = Boolean(article.source_checked);

    // 撤回按钮可见性
    if (article.status === 'published') {
      btnWithdrawArticle.style.display = 'inline-block';
    } else {
      btnWithdrawArticle.style.display = 'none';
    }

    editModal.style.display = 'flex';
  }

  function closeEditModal() {
    editModal.style.display = 'none';
    currentEditingArticle = null;
  }

  btnModalClose.addEventListener('click', closeEditModal);
  btnCancelEdit.addEventListener('click', closeEditModal);

  // 保存草稿 (PATCH)
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentEditingArticle) return;
    hideAlert(modalAlert);

    const payload = {
      title_zh: inputTitleZh.value.trim(),
      study_type: selectStudyType.value,
      evidence_basis: selectEvidenceBasis.value,
      summary: inputSummary.value.trim(),
      limitations: inputLimitations.value.trim(),
      reviewer: inputReviewer.value.trim(),
      source_checked: checkboxSourceChecked.checked,
    };

    const res = await apiFetch(`/api/editor/articles/${currentEditingArticle.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });

    if (res.ok && res.data.ok) {
      showAlert(modalAlert, '草稿保存成功！', false);
      showToast('草稿已保存');
      loadArticles();
      // 更新当前编辑对象
      currentEditingArticle = res.data.article;
      modalStatusBadge.className = 'badge badge-' + currentEditingArticle.status;
      modalStatusBadge.textContent = currentEditingArticle.status;
    } else {
      const errMsg = (res.data && res.data.error) || '保存失败';
      showAlert(modalAlert, errMsg, true);
    }
  });

  // 审核并发布 (POST .../publish)
  btnPublishArticle.addEventListener('click', async () => {
    if (!currentEditingArticle) return;
    hideAlert(modalAlert);

    // 先做一次保存
    const payload = {
      title_zh: inputTitleZh.value.trim(),
      study_type: selectStudyType.value,
      evidence_basis: selectEvidenceBasis.value,
      summary: inputSummary.value.trim(),
      limitations: inputLimitations.value.trim(),
      reviewer: inputReviewer.value.trim(),
      source_checked: checkboxSourceChecked.checked,
    };

    const saveRes = await apiFetch(`/api/editor/articles/${currentEditingArticle.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });

    if (!saveRes.ok) {
      showAlert(modalAlert, '更新字段失败: ' + (saveRes.data.error || '未知错误'), true);
      return;
    }

    // 提交发布请求
    const res = await apiFetch(`/api/editor/articles/${currentEditingArticle.id}/publish`, {
      method: 'POST',
    });

    if (res.ok && res.data.ok) {
      showAlert(modalAlert, '审核通过！文章已正式发布至公开日报。', false);
      showToast('发布成功！');
      btnWithdrawArticle.style.display = 'inline-block';
      loadArticles();
      currentEditingArticle = res.data.article;
      modalStatusBadge.className = 'badge badge-published';
      modalStatusBadge.textContent = '已发布状态 (公开可见)';
    } else {
      const msg = res.data.error || '发布校验失败';
      const details = res.data.details ? '（' + res.data.details.join('；') + '）' : '';
      showAlert(modalAlert, msg + details, true);
    }
  });

  // 撤回发布 (POST .../withdraw)
  btnWithdrawArticle.addEventListener('click', async () => {
    if (!currentEditingArticle) return;
    if (!confirm('确认要撤回该文章吗？撤回后公开日报将立即不可见。')) return;

    const res = await apiFetch(`/api/editor/articles/${currentEditingArticle.id}/withdraw`, {
      method: 'POST',
    });

    if (res.ok && res.data.ok) {
      showAlert(modalAlert, '文章已撤回，公开入口已立即不可见。', false);
      showToast('已撤回');
      btnWithdrawArticle.style.display = 'none';
      loadArticles();
      currentEditingArticle = res.data.article;
      modalStatusBadge.className = 'badge badge-withdrawn';
      modalStatusBadge.textContent = '已撤回状态 (公开不可见)';
    } else {
      showAlert(modalAlert, '撤回失败: ' + (res.data.error || '未知错误'), true);
    }
  });

  // ============================
  // 内部共读记录
  // ============================

  async function loadNotesHistory() {
    notesHistoryList.innerHTML = '';
    const res = await apiFetch('/api/editor/notes');
    if (!res.ok || !res.data.notes) {
      notesHistoryList.innerHTML = '<p class="muted">获取记录失败</p>';
      return;
    }

    const notes = res.data.notes;
    if (notes.length === 0) {
      notesHistoryList.innerHTML = '<p class="muted">暂无历史共读记录</p>';
      return;
    }

    notes.forEach((n) => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'selected-item';

      const keySpan = document.createElement('strong');
      keySpan.style.display = 'block';
      keySpan.textContent = n.key;

      const titleP = document.createElement('div');
      titleP.textContent = n.title || '（未命名主题）';

      const metaP = document.createElement('div');
      metaP.style.fontSize = '11px';
      metaP.style.color = 'var(--muted)';
      metaP.textContent = `${n.reviewer || '无审核人'} · ${(n.updated_at || '').split('T')[0]}`;

      const btnSwitch = document.createElement('button');
      btnSwitch.textContent = '载入编辑 ↗';
      btnSwitch.addEventListener('click', () => {
        noteKeyInput.value = n.key;
        loadNoteByKey(n.key);
      });

      itemDiv.appendChild(keySpan);
      itemDiv.appendChild(titleP);
      itemDiv.appendChild(metaP);
      itemDiv.appendChild(btnSwitch);
      notesHistoryList.appendChild(itemDiv);
    });
  }

  async function loadNoteByKey(key) {
    if (!key) return;
    const res = await apiFetch(`/api/editor/notes/${encodeURIComponent(key)}`);
    if (res.ok && res.data.note) {
      const n = res.data.note;
      noteTitleInput.value = n.title || '';
      noteReviewerInput.value = n.reviewer || '';
      noteContentTextarea.value = n.content || '';
      showToast(`已载入笔记 [${key}]`);
    }
  }

  btnLoadNote.addEventListener('click', () => {
    const key = noteKeyInput.value.trim();
    loadNoteByKey(key);
  });

  btnSaveNote.addEventListener('click', async () => {
    const key = noteKeyInput.value.trim();
    if (!key) {
      alert('请填写 Note Key');
      return;
    }

    const payload = {
      title: noteTitleInput.value.trim(),
      reviewer: noteReviewerInput.value.trim(),
      content: noteContentTextarea.value.trim(),
    };

    const res = await apiFetch(`/api/editor/notes/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    if (res.ok && res.data.ok) {
      showToast('内部共读记录已保存');
      loadNotesHistory();
    } else {
      alert('保存失败: ' + (res.data.error || '未知错误'));
    }
  });

  // ============================
  // 公开日报预览
  // ============================

  function initPreview() {
    if (!previewDateInput.value) {
      // 默认设为 2026-09-29
      previewDateInput.value = '2026-09-29';
    }
    loadPreview();
  }

  async function loadPreview() {
    const dateVal = previewDateInput.value || '2026-09-29';
    previewArticlesContainer.innerHTML = '<div class="empty">正在获取公开数据...</div>';

    const res = await apiFetch(`/api/public/briefings?date=${encodeURIComponent(dateVal)}`);
    previewArticlesContainer.innerHTML = '';

    if (!res.ok) {
      previewArticlesContainer.innerHTML = `<div class="empty">获取公开数据失败: ${res.data.error || '未知错误'}</div>`;
      return;
    }

    const items = res.data.items || [];
    if (items.length === 0) {
      previewArticlesContainer.innerHTML = `<div class="empty">${dateVal} 暂无已发布公开文章（撤回或未发布的文章均不会在此出现）。</div>`;
      return;
    }

    items.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'paper';
      card.style.background = 'var(--white)';
      card.style.padding = '20px';
      card.style.border = '1px solid var(--line)';
      card.style.marginBottom = '15px';

      const metaDiv = document.createElement('div');
      metaDiv.className = 'meta';

      const catPill = document.createElement('span');
      catPill.className = 'pill';
      catPill.textContent = item.category || 'AI医疗';

      const sourceSpan = document.createElement('span');
      sourceSpan.textContent = item.source || '期刊源';

      const dateSpan = document.createElement('span');
      dateSpan.textContent = '发布日期: ' + (item.published_date || dateVal);

      const typeSpan = document.createElement('span');
      typeSpan.textContent = item.study_type ? '研究类型: ' + item.study_type : '';

      metaDiv.appendChild(catPill);
      metaDiv.appendChild(sourceSpan);
      metaDiv.appendChild(dateSpan);
      if (item.study_type) metaDiv.appendChild(typeSpan);
      card.appendChild(metaDiv);

      const h3 = document.createElement('h3');
      const a = document.createElement('a');
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = (item.title_zh ? item.title_zh : item.title) + ' ↗';
      h3.appendChild(a);
      card.appendChild(h3);

      if (item.title_zh) {
        const origP = document.createElement('p');
        origP.style.color = 'var(--muted)';
        origP.style.fontSize = '12px';
        origP.textContent = '原题：' + item.title;
        card.appendChild(origP);
      }

      if (item.summary) {
        const sumP = document.createElement('p');
        sumP.style.fontSize = '13px';
        sumP.style.lineHeight = '1.8';
        sumP.textContent = item.summary;
        card.appendChild(sumP);
      }

      if (item.limitations) {
        const limBox = document.createElement('div');
        limBox.className = 'note';
        limBox.style.marginTop = '10px';
        limBox.textContent = '局限性与警示：' + item.limitations;
        card.appendChild(limBox);
      }

      previewArticlesContainer.appendChild(card);
    });
  }

  btnRefreshPreview.addEventListener('click', loadPreview);
  previewDateInput.addEventListener('change', loadPreview);

  // 初始化检查登录
  checkSession();
})();
