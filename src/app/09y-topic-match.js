  // ==== src/app/09y-topic-match.js · Topic matching, counts and display ====
  const TOPIC_GROUPS = [
    ['临床亚专科', ['#房颤/电生理', '#心衰/心肌', '#卒中/抗凝', '#高血压/血管', '#冠脉介入', '#结构性心脏病', '#先心病', '#预防/血脂']],
    ['检查与手段', ['#心电', '#影像']],
    ['AI 与数字医学', ['#AI-ECG', '#大模型/NLP', '#AI-RCT证据', '#穿戴/远程监测']]
  ];

  function topicModeLabel(mode) {
    return normalizeTagMode(mode) === 'all' ? '同时包含' : '任一';
  }

  function paperMatchesTopics(paper, tags, mode) {
    if (!tags.length) return true;
    const paperTags = paperTopicTags(paper);
    if (tags[0] === UNCLASSIFIED_TOPIC) return paperTags.length === 0;
    const includes = tag => paperTags.includes(tag);
    return mode === 'all' ? tags.every(includes) : tags.some(includes);
  }

  function topicToggle(tags, tag) {
    return tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag];
  }

  function topicResultCount(papers) {
    if (state.mode !== 'curated') return papers.length;
    const days = new Map();
    for (const paper of papers) {
      const date = publishedDate(paper);
      days.set(date, (days.get(date) || 0) + 1);
    }
    const day = curatedDay([...days].sort(([a], [b]) => b.localeCompare(a)));
    return day ? days.get(day) : papers.length;
  }

  function topicOptionCounts(papers, keys, active, mode, unclassified) {
    const count = (tags, matchMode = mode) =>
      topicResultCount(papers.filter(p => paperMatchesTopics(p, tags, matchMode)));
    return {
      clear: topicResultCount(papers),
      unclassified: count(unclassified ? [] : [UNCLASSIFIED_TOPIC]),
      modes: { any: count(unclassified ? [UNCLASSIFIED_TOPIC] : active, 'any'), all: count(unclassified ? [UNCLASSIFIED_TOPIC] : active, 'all') },
      tags: new Map(keys.map(tag => [tag, count(topicToggle(active, tag))]))
    };
  }

  function topicGroupsFor(papers, active) {
    const extras = new Set(active.filter(tag => !TOPIC_TAGS.includes(tag)));
    for (const paper of papers) {
      paperTopicTags(paper).forEach(tag => { if (!TOPIC_TAGS.includes(tag)) extras.add(tag); });
    }
    return extras.size ? [...TOPIC_GROUPS, ['其他', [...extras]]] : TOPIC_GROUPS;
  }

  function quickTierResultCounts() {
    const papers = qfPapers().filter(p => matchesFilters(p, false, 'pub'));
    const tiers = new Map();
    for (const paper of papers) {
      const id = paperTierId(paper);
      if (!tiers.has(id)) tiers.set(id, []);
      tiers.get(id).push(paper);
    }
    const counts = new Map([...tiers].map(([id, rows]) => [id, topicResultCount(rows)]));
    // Clicking the active whole tier removes it. A non-empty subset is replaced by the whole tier.
    if (state.journalTier && !selectedJournals().length) {
      const afterClear = state.publisher
        ? papers.filter(p => (p.publisher || '其他学术刊物') === state.publisher) : papers;
      counts.set(state.journalTier, topicResultCount(afterClear));
    }
    return counts;
  }

  function topicPickerHtml(papers) {
    const active = selectedTags();
    const unclassified = isTopicUnclassified();
    const mode = normalizeTagMode(state.tagMode);
    const groups = topicGroupsFor(papers, active);
    const counts = topicOptionCounts(papers, groups.flatMap(([, tags]) => tags), active, mode, unclassified);
    const option = (attr, value, label, on, count) =>
      `<button type="button" class="qf-opt${on ? ' is-on' : ''}${count ? '' : ' is-empty'}" data-qf-topic${attr}="${esc(value)}" aria-pressed="${on}"><span>${esc(label)}</span> <small>${count}</small></button>`;
    const modeButton = (key, name) =>
      `<button type="button" class="qf-opt${mode === key && !unclassified ? ' is-on' : ''}${counts.modes[key] ? '' : ' is-empty'}" data-qf-topic-mode="${key}" aria-pressed="${mode === key && !unclassified}"${unclassified ? ' disabled' : ''}>${name} <small>${counts.modes[key]}</small></button>`;
    const hint = unclassified ? '已选「未分类」，匹配方式不适用。' : active.length === 1 ? '单选时无区别。' : '';
    return `<div class="topic-picker">
      <div class="qf-pop-head"><strong>文章主题</strong><button type="button" class="qf-pop-close" data-qf-close="1" aria-label="关闭">×</button></div>
      <p class="qf-hint" id="topicModeHint">任一或同时包含所选主题，和其他筛选叠加。「未分类」与具体主题互斥。${hint}</p>
      <div class="topic-options" role="group" aria-label="文章主题匹配方式" aria-describedby="topicModeHint">
        ${modeButton('any', '任一 (OR)')}${modeButton('all', '同时包含 (AND)')}
      </div>
      <div class="topic-options">
        ${option('-all', '1', '全部（清空文章主题筛选）', !unclassified && !active.length, counts.clear)}
        ${option('-unclassified', '1', '未分类（无可用主题标签）', unclassified, counts.unclassified)}
      </div>
      ${groups.map(([name, tags]) => `<section class="topic-group" aria-label="${esc(name)}">
        <h4>${esc(name)} <span>已选 ${tags.filter(t => active.includes(t)).length}</span></h4>
        <div class="topic-options">${tags.map(t => option('', t, t, active.includes(t), counts.tags.get(t))).join('')}</div>
      </section>`).join('')}
    </div>`;
  }

  function topicBadgeHtml(paper) {
    const tags = paperTopicTags(paper);
    if (!tags.length) return '';
    const active = selectedTags();
    const visible = tags.slice(0, 3).map(tag =>
      `<button type="button" class="topic-badge" data-filter-tag="${esc(tag)}" aria-pressed="${active.includes(tag)}">${esc(tag)}</button>`);
    if (tags.length > 3) visible.push(`<span class="topic-badge-more" aria-label="另有 ${tags.length - 3} 个主题">+${tags.length - 3}</span>`);
    return `<div class="topic-badges" role="group" aria-label="文章主题">${visible.join('')}</div>`;
  }
