function runQuestionAssistant(bank) {
  const page = new URL(location.href);
  if (!['http:', 'https:'].includes(page.protocol)) return;
  const stage = page.searchParams.get('stg');
  if (!stage) return;
  const cleanPath = url => url.pathname.replace(/\/$/, '') || '/';
  const configured = GM_getValue('routes:' + page.origin, null);
  const defaults = ['/jjfz/lesson', '/jjfz/lesson/video', '/jjfz/play', '/jjfz/lesson/exam', '/jjfz/exam_center/end_exam'];
  let routes = defaults;
  if (Array.isArray(configured) && [3, 5].includes(configured.length)) {
    try {
      const urls = configured.map(path => new URL(path, page.origin));
      if (urls.every(url => url.origin === page.origin && !url.username && !url.password)) {
        const paths = urls.map(cleanPath);
        routes = paths.length === 5 ? paths : [...paths, paths[0] + '/exam', paths[0].replace(/\/[^/]+$/, '') + '/exam_center/end_exam'];
      }
    } catch { /* 保留默认地址。 */ }
  }
  const path = cleanPath(page);
  const chapter = path === routes[3];
  if (!chapter && path !== routes[4]) return;
  const lesson = page.searchParams.get('lesson_id');
  if (chapter && !/^\d+$/.test(lesson)) return;
  const count = document.querySelectorAll('.exam_num_lists li').length;
  if (!count || count > 500 || !document.querySelector('.exam_cont_left .exam_h2')) return;
  if (document.getElementById('jjfz-question-assistant')) return;

  const endpoint = chapter ? path : path.replace(/\/[^/]+$/, '');
  const match = createMatcher(bank);
  const initialHref = page.href;
  const touched = new Set();
  let rows = [];
  let busy = false;
  const preference = 'question-mode:' + page.origin;
  const panel = document.createElement('details');
  panel.id = 'jjfz-question-assistant';
  panel.open = true;
  Object.assign(panel.style, {
    position: 'fixed', right: '12px', bottom: '12px', width: 'min(460px, 90vw)', zIndex: '10000',
    background: '#fff', color: '#20252b', border: '1px solid #bec8d2', borderRadius: '10px',
    boxShadow: '0 3px 18px #0003', padding: '12px', font: '14px/1.55 sans-serif'
  });
  const element = (tag, text, parent = panel) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    parent.append(node);
    return node;
  };
  element('summary', `题库辅助 · ${bank.length} 题 · 手动交卷`);
  element('p', '视频学习结束后，由你打开自测。匹配和填写在当前试卷内进行，每章最后由你在网站交卷。');
  const mode = element('select');
  mode.setAttribute('aria-label', '答题模式');
  const preferredMode = GM_getValue(preference, 'manual') === 'reference' ? 'reference' : 'manual';
  for (const [value, text] of [['manual', '填写可靠匹配的答案，每章手动交卷'], ['reference', '仅显示参考答案，自己填写并交卷']]) {
    const option = element('option', text, mode);
    option.value = value;
    if (value === preferredMode) option.selected = true;
  }
  const controls = element('div');
  Object.assign(controls.style, { display: 'flex', gap: '8px', margin: '10px 0', flexWrap: 'wrap' });
  const scanButton = element('button', chapter ? '匹配本章题目' : '匹配当前试卷', controls);
  scanButton.id = 'jjfz-question-scan';
  const fillButton = element('button', '填写可靠答案（手动交卷）', controls);
  fillButton.id = 'jjfz-question-fill';
  for (const button of [scanButton, fillButton]) {
    button.type = 'button';
    Object.assign(button.style, { padding: '6px 10px', cursor: 'pointer' });
  }
  const message = element('p', `当前 ${count} 题。点击匹配后检查结果，网站倒计时继续生效，请及时核对和交卷。`);
  message.setAttribute('role', 'status');
  const list = element('div');
  Object.assign(list.style, { maxHeight: '300px', overflowY: 'auto', overflowWrap: 'anywhere' });
  document.body.append(panel);

  const labels = {
    exact: '可靠匹配', similar: '题干近似，仅供核对', missing: '未匹配，请手动处理',
    conflict: '答案冲突，请手动处理', 'options-changed': '选项发生变化，请手动核对', invalid: '题目结构异常',
    saved: '已保存，等待你交卷', answered: '已有作答，保留原答案', changed: '题目或作答已变化，请重新核对', failed: '保存未确认，请手动核对'
  };
  function setMessage(text) { message.textContent = text; }
  function isAnswered(question) { return question.type === 'fill' ? Boolean(question.answer) : question.selected.length > 0; }
  function fingerprint(question) {
    return JSON.stringify([question.index, question.qid, question.type, question.question, question.options]);
  }
  function chosen(question) { return question.type === 'fill' ? question.answer : [...question.selected].sort().join('|'); }
  function active() {
    if (location.href !== initialHref) throw Error('页面已切换，请在当前试卷重新匹配。');
  }
  function render() {
    list.replaceChildren();
    for (const row of rows) {
      const item = element('div', '', list);
      Object.assign(item.style, { padding: '8px 0', borderTop: '1px solid #e0e6eb' });
      const heading = element('button', `${row.question.index}. ${labels[row.state]}`, item);
      heading.type = 'button';
      heading.addEventListener('click', () => document.querySelectorAll('.exam_num_lists li')[row.question.index - 1]?.click());
      element('div', row.question.question, item);
      if (row.result.answers) element('div', '参考答案：' + row.result.answers.join('；'), item);
      if (row.result.status === 'similar') element('div', '相近题干：' + row.result.question, item);
    }
    scanButton.disabled = busy;
    mode.disabled = busy;
    fillButton.disabled = busy || mode.value !== 'manual' || !rows.some(row => row.state === 'exact');
  }
  function address(action, index) {
    const url = new URL(endpoint + '/' + action, page.origin);
    url.searchParams.set('stg', stage);
    if (chapter) url.searchParams.set('lesson_id', lesson);
    if (index) url.searchParams.set('i', String(index));
    return url;
  }
  async function readQuestion(index) {
    active();
    const url = address('get_question', index);
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw Error(`读取题目失败（HTTP ${response.status}）。`);
        break;
      } catch (error) {
        if (attempt) throw error;
        active();
      }
    }
    const html = await response.text();
    active();
    return parseQuestion(new DOMParser().parseFromString(html, 'text/html'), index);
  }
  async function scan() {
    if (busy) return;
    busy = true;
    rows = [];
    render();
    try {
      for (let index = 1; index <= count; index++) {
        setMessage(`正在匹配 ${index}/${count} 题。`);
        const question = await readQuestion(index);
        const result = match(question);
        rows.push({ question, result, state: isAnswered(question) ? 'answered' : result.status });
      }
      const reliable = rows.filter(row => row.result.status === 'exact').length;
      setMessage(`已匹配 ${count} 题：可靠 ${reliable}，待核对 ${count - reliable}。已有作答会保留。填写结束后请检查并在网站手动交卷。`);
    } catch (error) {
      rows = [];
      setMessage('匹配中断：' + error.message + ' 请重新匹配或手动做题。');
    } finally {
      busy = false;
      render();
    }
  }
  function updateVisible(question, result) {
    const root = document.querySelector('.exam_cont_left');
    if (!root) return;
    try {
      const visible = parseQuestion(root, question.index);
      if (fingerprint(visible) !== fingerprint(question)) return;
    } catch { return; }
    if (question.type === 'fill') root.querySelector('.summary_question').value = result.text;
    else for (const label of root.querySelectorAll('.answer_list label,.answer_list_box label')) {
      const input = label.querySelector('input');
      const selected = result.values.includes(input.value);
      input.checked = selected;
      label.classList.toggle('checked', selected);
      label.closest('li')?.classList.toggle('result_cut', selected);
    }
    document.getElementById(question.qid)?.classList.add('done');
  }
  async function fill() {
    if (busy || mode.value !== 'manual' || !rows.length) return;
    busy = true;
    render();
    let saved = 0;
    try {
      for (const row of rows) {
        if (row.state !== 'exact') continue;
        active();
        const question = await readQuestion(row.question.index);
        if (fingerprint(question) !== fingerprint(row.question) || touched.has(question.qid)) {
          row.state = 'changed';
          continue;
        }
        if (isAnswered(question) || chosen(question) !== chosen(row.question)) {
          row.state = 'answered';
          continue;
        }
        const result = match(question);
        if (result.status !== 'exact') { row.state = 'changed'; continue; }
        const token = document.querySelector('input[name="_xsrf"]')?.value;
        if (!token) throw Error('登录凭据已失效，请核对登录状态。');
        const fields = { stg: stage, i: String(question.index), qid: question.qid, answer: question.type === 'fill' ? result.text : result.values.join('|'), _xsrf: token };
        if (chapter) fields.lesson_id = lesson;
        row.state = 'failed';
        const response = await fetch(address('answer', question.index), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { 'X-XSRFToken': token }, body: new URLSearchParams(fields)
        });
        if (!response.ok) throw Error(`保存失败（HTTP ${response.status}）。`);
        const reply = await response.json();
        active();
        if (Number(reply.code) !== 1) throw Error(reply.message || '网站未确认保存。');
        const stored = await readQuestion(question.index);
        const expected = question.type === 'fill' ? result.text : [...result.values].sort().join('|');
        if (fingerprint(stored) !== fingerprint(question) || chosen(stored) !== expected) throw Error('保存结果与预期不符。');
        row.state = 'saved';
        saved++;
        updateVisible(question, result);
        setMessage(`已确认保存 ${saved} 题。所有题目完成后由你手动交卷。`);
      }
      const pending = rows.filter(row => !['saved', 'answered'].includes(row.state)).length;
      setMessage(`已确认保存 ${saved} 题，保留已有作答 ${rows.filter(row => row.state === 'answered').length} 题，待处理 ${pending} 题。请核对答题卡，并在网站手动交卷。`);
    } catch (error) {
      setMessage(`已确认保存 ${saved} 题，填写已停止：${error.message} 请核对答题卡后手动交卷。`);
    } finally {
      busy = false;
      render();
    }
  }
  for (const event of ['input', 'change']) document.addEventListener(event, e => {
    if (!e.target.closest?.('.exam_cont_left')) return;
    const qid = e.target.getAttribute('qid') ?? e.target.closest('[qid]')?.getAttribute('qid');
    if (qid) touched.add(qid);
  }, true);
  mode.addEventListener('change', () => { GM_setValue(preference, mode.value); render(); });
  scanButton.addEventListener('click', () => { void scan(); });
  fillButton.addEventListener('click', () => { void fill(); });
  GM_registerMenuCommand('匹配当前试卷（每章手动交卷）', () => { panel.open = true; return scan(); });
  GM_registerMenuCommand('填写可靠答案（每章手动交卷）', () => { panel.open = true; return fill(); });
  render();
}

if (typeof module !== 'undefined') module.exports = { runQuestionAssistant };
