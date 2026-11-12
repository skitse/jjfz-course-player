const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { parseHTML, DOMParser } = require('linkedom');

const source = ['question-core.js', 'question-assistant.js'].map(name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')).join('\n');
const bank = [
  { type: 'single', question: '选择正确的字符。', options: ['甲', '乙'], answers: ['乙'] },
  { type: 'multiple', question: '选择所有正确的字符。', options: ['甲', '乙', '丙'], answers: ['甲', '丙'] },
  { type: 'fill', question: '填入本地测试答案（）。', options: [], answers: ['本地测试答案'] }
];
const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function fixture({ href = 'https://training.example/jjfz/lesson/exam?lesson_id=12&stg=51', unknown = false,
  failure = false, mismatch = false, selected = false, mode = 'manual', routes } = {}) {
  const page = new URL(href);
  const questions = bank.map((q, i) => ({ ...q, index: i + 1, qid: String(100 + i), selected: [], answer: '' }));
  if (unknown) questions.push({ ...bank[0], question: '这道题没有收录。', index: 4, qid: '104', selected: [], answer: '' });
  if (selected) questions[0].selected = ['1000'];
  function markup(q) {
    const type = { single: '单选题', multiple: '多选题', fill: '填空题' }[q.type];
    const header = `<div class="e_cont_title"><span>${type}</span></div><h2 class="exam_h2">${q.index}. ${escape(q.question)}</h2>`;
    if (q.type === 'fill') return header + `<input class="summary_question" qindex="${q.index}" qid="${q.qid}" value="${escape(q.answer)}">`;
    return header + `<ul class="${q.type === 'multiple' ? 'answer_list_box' : 'answer_list'}" qindex="${q.index}" qid="${q.qid}">`
      + q.options.map((text, i) => `<li><label class="${q.selected.includes(q.qid + i) ? 'checked' : ''}"><input type="${q.type === 'multiple' ? 'checkbox' : 'radio'}" qid="${q.qid}" value="${q.qid + i}">${escape(text)}</label></li>`).join('') + '</ul>';
  }
  const { document, Event } = parseHTML(`<html><body><input name="_xsrf" value="fixture-token"><div class="exam_cont_left">${markup(questions[0])}</div><div class="exam_num_lists"><ul>${questions.map(q => `<li id="${q.qid}">${q.index}</li>`).join('')}</ul></div></body></html>`);
  const menus = new Map(), requests = [], writes = [];
  const preferences = new Map([['question-mode:' + page.origin, mode]]);
  if (routes) preferences.set('routes:' + page.origin, routes);
  const location = { href };
  let readFailure = false;
  runInNewContext(source + '\nrunQuestionAssistant(inputBank);', {
    inputBank: JSON.parse(JSON.stringify(bank)), document, location, URL, URLSearchParams, DOMParser, AbortSignal, console,
    GM_getValue: (key, fallback) => preferences.get(key) ?? fallback,
    GM_setValue: (key, value) => preferences.set(key, value),
    GM_registerMenuCommand: (label, fn) => menus.set(label, fn),
    fetch: async (address, config) => {
      const url = new URL(address);
      requests.push([url.pathname, config.method ?? 'GET']);
      assert.equal(url.origin, page.origin);
      assert.equal(url.searchParams.get('stg'), '51');
      assert.equal(config.redirect, 'error');
      assert.ok(!/submit|end_exam$|logout/.test(url.pathname), 'assistant must never submit, start or exit a paper');
      const index = Number(url.searchParams.get('i'));
      const q = questions[index - 1];
      assert.ok(q);
      if (url.pathname.endsWith('/get_question')) {
        if (readFailure) throw Error('Network failure');
        return { ok: true, text: async () => markup(q) };
      }
      assert.ok(url.pathname.endsWith('/answer'));
      assert.equal(config.headers['X-XSRFToken'], 'fixture-token');
      assert.equal(config.body.get('qid'), q.qid);
      writes.push(index);
      if (failure) return { ok: true, json: async () => ({ code: 0, message: 'Save failed' }) };
      if (!mismatch) {
        if (q.type === 'fill') q.answer = config.body.get('answer');
        else q.selected = config.body.get('answer').split('|');
      }
      return { ok: true, json: async () => ({ code: 1 }) };
    }
  });
  const action = text => [...menus].find(([label]) => label.startsWith(text))?.[1];
  return { document, Event, requests, writes, questions, location,
    scan: () => action('匹配当前试卷')?.(), fill: () => action('填写可靠答案')?.(),
    status: () => document.querySelector('#jjfz-question-assistant [role=status]')?.textContent,
    failReads: () => { readFailure = true; } };
}

test('does nothing until the user explicitly starts matching; never starts a quiz or mixes the video flow', () => {
  const exam = fixture();
  assert.equal(exam.requests.length, 0);
  for (const route of ['/jjfz/lesson', '/jjfz/play', '/jjfz/lesson/exam/result', '/jjfz/exam_center/show', '/jjfz/exam_center']) {
    const f = fixture({ href: 'https://training.example' + route + '?stg=51' });
    assert.equal(f.document.querySelector('#jjfz-question-assistant'), null);
    assert.equal(f.requests.length, 0);
  }
});

test('fills only exact answers, checks each server save, marks pending questions and leaves submission manual', async () => {
  const f = fixture({ unknown: true });
  await f.scan();
  assert.equal(f.writes.length, 0);
  assert.match(f.status(), /可靠 3，待核对 1/);
  await f.fill();
  assert.deepEqual(f.writes, [1, 2, 3]);
  assert.deepEqual(f.questions[0].selected, ['1001']);
  assert.deepEqual(f.questions[1].selected, ['1010', '1012']);
  assert.equal(f.questions[2].answer, '本地测试答案');
  assert.match(f.status(), /保存 3 题.*待处理 1 题/);
  assert.match(f.status(), /手动交卷/);
  await f.fill();
  assert.equal(f.writes.length, 3, 'repeated clicks do not rewrite saved answers');
});

test('reference-only mode never writes and existing answers are preserved in manual mode', async () => {
  const reference = fixture({ mode: 'reference' });
  await reference.scan();
  await reference.fill();
  assert.equal(reference.writes.length, 0);
  const existing = fixture({ selected: true });
  await existing.scan();
  await existing.fill();
  assert.deepEqual(existing.writes, [2, 3]);
  assert.deepEqual(existing.questions[0].selected, ['1000']);
});

test('rechecks answers changed on the server or by user input after matching', async () => {
  const f = fixture();
  await f.scan();
  f.questions[0].selected = ['1000'];
  await f.fill();
  assert.deepEqual(f.writes, [2, 3]);
  const g = fixture();
  await g.scan();
  const input = g.document.querySelector('.exam_cont_left input');
  input.dispatchEvent(new g.Event('change', { bubbles: true }));
  await g.fill();
  assert.deepEqual(g.writes, [2, 3]);
});

test('stops on failed save or unconfirmed persistence rather than proceeding with the rest of a paper', async () => {
  for (const option of [{ failure: true }, { mismatch: true }]) {
    const f = fixture(option);
    await f.scan();
    await f.fill();
    assert.deepEqual(f.writes, [1]);
    assert.match(f.status(), /填写已停止/);
    assert.match(f.document.querySelector('#jjfz-question-assistant').textContent, /保存未确认/);
  }
});

test('failed reads and changed paper identities discard stale actions', async () => {
  const f = fixture();
  f.failReads();
  await f.scan();
  await f.fill();
  assert.equal(f.writes.length, 0);
  assert.match(f.status(), /匹配中断/);
  const g = fixture();
  await g.scan();
  g.location.href = 'https://training.example/jjfz/lesson/exam?lesson_id=13&stg=51';
  await g.fill();
  assert.equal(g.writes.length, 0);
  assert.match(g.status(), /页面已切换/);
});

test('supports comprehensive papers and five explicit custom routes on another compatible site', async () => {
  for (const options of [
    { href: 'https://training.example/jjfz/exam_center/end_exam?stg=51' },
    { href: 'https://training.example/training/test?lesson_id=12&stg=51', routes: ['/training/courses', '/training/catalog', '/training/video', '/training/test', '/training/all/start'] }
  ]) {
    const f = fixture(options);
    await f.scan();
    await f.fill();
    assert.deepEqual(f.writes, [1, 2, 3]);
  }
});
