const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMatcher, normalizeText, parseQuestion } = require('../src/question-core.js');
const { DOMParser } = require('linkedom');
const bank = require('../data/questions.json');

test('every verified answer maps to reordered option text, including all fill answers', () => {
  const match = createMatcher(bank.questions);
  for (const row of bank.questions) {
    const options = [...row.options].reverse().map((text, i) => ({ text, value: String(i + 100) }));
    const result = match({ ...row, options });
    assert.equal(result.status, 'exact', row.question);
    if (row.type === 'fill') assert.equal(result.text, row.answers[0]);
    else assert.deepEqual(result.values.sort(), options.filter(o => row.answers.includes(o.text)).map(o => o.value).sort());
  }
});

test('handles width, whitespace, punctuation and blank markers without losing decimal numbers or logic', () => {
  assert.equal(normalizeText('甲，乙（  ）？'), normalizeText('甲, 乙()。'));
  assert.notEqual(normalizeText('1.5年'), normalizeText('15年'));
  assert.notEqual(normalizeText('可以'), normalizeText('不可以'));
  assert.notEqual(normalizeText('A+B'), normalizeText('AB'));
  assert.notEqual(normalizeText('1/2'), normalizeText('12'));
  assert.notEqual(normalizeText('20—30'), normalizeText('2030'));
});

const single = { type: 'single', question: '这道用于核对选项顺序的测试题正确的答案是哪一项？', options: ['甲', '乙', '丙'], answers: ['乙'] };
function question(row = single) {
  return { ...row, options: row.options.map((text, i) => ({ text, value: String(i) })) };
}

test('changed option sets, duplicate option labels and missing options require review', () => {
  const match = createMatcher([single]);
  assert.equal(match(question({ ...single, options: ['甲', '乙', '丁'] })).status, 'options-changed');
  assert.equal(match(question({ ...single, options: ['甲', '乙', '乙'] })).status, 'invalid');
  assert.equal(match(question({ ...single, options: [] })).status, 'invalid');
});

test('conflicting verified records are never filled and unknown answers remain unresolved', () => {
  const match = createMatcher([single, { ...single, answers: ['甲'] }]);
  assert.equal(match(question()).status, 'conflict');
  assert.equal(createMatcher([single])({ ...question(), title: undefined, question: '题库没有这道题' }).status, 'missing');
});

test('near matches are suggestions only, even with nearly identical text and options', () => {
  const row = { ...single, question: '为了测试文本匹配在题干发生轻微变化时的行为，我们给这道练习题增加足够长的文字，正确答案是哪一个选项？' };
  const result = createMatcher([row])(question({ ...row, question: row.question.replace('练习题', '测试题') }));
  assert.equal(result.status, 'similar');
  assert.equal(result.values, undefined);
});

test('near matching rejects changes in negation, dates, numbers and mandatory words', () => {
  const row = { ...single, question: '根据有关规定，请认真核对本题中所描述的具体条件和限制，党员必须在三年以后完成这个任务，以下哪一个选项正确？' };
  const match = createMatcher([row]);
  for (const text of [row.question.replace('必须', '可以'), row.question.replace('三年', '五年'), row.question.replace('以后', '以前'), row.question.replace('正确', '错误')]) {
    assert.equal(match(question({ ...row, question: text })).status, 'missing', text);
  }
});

test('boolean aliases map by meaning, rather than A/B', () => {
  const row = { type: 'boolean', question: '这是判断题。', options: ['正确', '错误'], answers: ['错误'] };
  const result = createMatcher([row])({ type: 'boolean', question: row.question, options: [{ text: '错', value: 'yes' }, { text: '对', value: 'no' }] });
  assert.deepEqual(result.values, ['yes']);
});

test('parses real single, multiple and fill structures and refuses inconsistent identifiers', () => {
  const parse = html => parseQuestion(new DOMParser().parseFromString(html, 'text/html'), 1);
  const html = '<div class="e_cont_title"><span>单选题（每题5分）</span></div><h2 class="exam_h2">1. 示例题？</h2><ul class="answer_list" qindex="1"><li><label class="checked"><input type="radio" qid="42" value="101">甲</label></li><li><label><input type="radio" qid="42" value="102">乙</label></li></ul>';
  const q = parse(html);
  assert.equal(q.qid, '42');
  assert.equal(q.question, '示例题？');
  assert.deepEqual(q.selected, ['101']);
  assert.equal(q.type, 'single');
  assert.throws(() => parse(html.replace('qindex="1"', 'qindex="2"')), /序号/);
  assert.throws(() => parse(html.replace('value="102"', 'value="101"')), /选项/);
  const fill = parse('<div class="e_cont_title"><span>填空题</span></div><h2 class="exam_h2">1. 填空（）。</h2><input class="summary_question" qindex="1" qid="99" value="答案">');
  assert.equal(fill.answer, '答案');
  assert.equal(fill.type, 'fill');
});

test('public bank contains question data only, with no account IDs, scores or private URLs', () => {
  assert.equal(bank.records, 360);
  assert.equal(bank.questions.length, 350);
  assert.doesNotMatch(JSON.stringify(bank), /https?:\/\/|rid=|_xsrf|考试时间|wasCorrect|lesson_id/);
  for (const row of bank.questions) assert.deepEqual(Object.keys(row).sort(), ['answers', 'options', 'question', 'type']);
});
