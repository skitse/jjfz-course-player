function normalizeText(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/(?<=\d)\.(?=\d)/g, '\uE001')
    .replace(/[（(]\s*[）)]|_{2,}/g, '□')
    .replace(/[\p{P}\p{Z}\s]/gu, character => /[+\-=%<>/—–]/.test(character) ? character : '')
    .replace(/\uE001/g, '.');
}

function optionText(value, type) {
  const text = normalizeText(value);
  if (type !== 'boolean') return text;
  if (['正确', '对', '是', '√'].includes(text)) return 'true';
  if (['错误', '错', '否', '×'].includes(text)) return 'false';
  return text;
}

function criticalText(text) {
  return String(text).normalize('NFKC').replace(/\s/g, '').match(
    /\d+(?:\.\d+)?|[一二三四五六七八九十百千万两]+(?=[年月日次个届项])|不得|不能|不|未|无|非|否|必须|应当|可以|只能|至少|以上|以下|以前|以后|之前|之后|正确|错误|首次|最早|最初|根本|主要|重要|首要|[+\-=%<>/—–≤≥≠]/g
  )?.join('|') ?? '';
}

function textSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] !== right[j - 1]));
    }
    previous = next;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function createMatcher(bank) {
  const records = bank.map(row => ({ ...row, normalized: normalizeText(row.question) }));
  const index = new Map();
  for (const row of records) {
    const key = row.type + ':' + row.normalized;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  const signature = (values, type) => JSON.stringify(values.map(value => optionText(value, type)).sort());
  return function match(question) {
    const type = question.type;
    const text = normalizeText(question.question);
    const options = question.options ?? [];
    const texts = options.map(o => optionText(o.text, type));
    if (!text || !['single', 'multiple', 'boolean', 'fill'].includes(type)
      || (type !== 'fill' && (texts.length < 2 || new Set(texts).size !== texts.length))) return { status: 'invalid' };
    const exact = index.get(type + ':' + text) ?? [];
    if (exact.length) {
      const compatible = exact.filter(row => type === 'fill' || signature(row.options, type) === signature(options.map(o => o.text), type));
      if (!compatible.length) return { status: 'options-changed' };
      const answers = new Map(compatible.map(row => [signature(row.answers, type), row.answers]));
      if (answers.size !== 1) return { status: 'conflict' };
      const answer = [...answers.values()][0];
      if ((type === 'fill' || type !== 'multiple') && answer.length !== 1) return { status: 'conflict' };
      if (type === 'fill') return { status: 'exact', text: answer[0], answers: answer };
      const keys = answer.map(a => optionText(a, type));
      if (keys.some(a => !texts.includes(a)) || new Set(keys).size !== keys.length) return { status: 'conflict' };
      const mapped = options.filter(o => keys.includes(optionText(o.text, type)));
      return { status: 'exact', values: mapped.map(o => o.value), answers: answer };
    }
    if (text.length < 30 || text.length > 1200) return { status: 'missing' };
    const near = records.filter(row => row.type === type && criticalText(row.question) === criticalText(question.question)
      && Math.abs(row.normalized.length - text.length) < Math.max(text.length * 0.08, 2)
      && (type === 'fill' || signature(row.options, type) === signature(options.map(o => o.text), type)))
      .map(row => ({ row, score: textSimilarity(text, row.normalized) })).filter(row => row.score >= 0.94)
      .sort((a, b) => b.score - a.score);
    if (!near.length) return { status: 'missing' };
    return { status: 'similar', answers: near[0].row.answers, question: near[0].row.question, score: near[0].score };
  };
}

function parseQuestion(doc, expectedIndex) {
  const heading = doc.querySelector('.exam_h2');
  const typeText = doc.querySelector('.e_cont_title span')?.textContent ?? '';
  const type = typeText.includes('多选') ? 'multiple' : typeText.includes('判断') ? 'boolean'
    : typeText.includes('填空') ? 'fill' : typeText.includes('单选') ? 'single' : null;
  const container = doc.querySelector('.summary_question') ?? doc.querySelector('[qindex]');
  const index = Number(container?.getAttribute('qindex'));
  const qids = [...doc.querySelectorAll('[qid]')].map(e => e.getAttribute('qid'));
  const qid = qids[0];
  if (!heading || !type || !qid || !/^\d+$/.test(qid) || qids.some(id => id !== qid)) throw Error('题目结构或标识发生变化。');
  if (index !== expectedIndex) throw Error('题目序号发生变化。');
  const question = heading.textContent.replace(/^\s*\d+[.、．]\s*/, '').trim();
  const labels = [...doc.querySelectorAll('.answer_list label,.answer_list_box label')];
  const options = labels.map(label => ({ text: label.textContent.replace(/^\s*[A-Z][、.．]\s*/, '').trim(), value: label.querySelector('input')?.value }));
  if (!question || (type !== 'fill' && (options.length < 2 || options.some(o => !o.value || !o.text)
    || new Set(options.map(o => o.value)).size !== options.length))) throw Error('题目选项发生变化。');
  return { index, qid, type, question, options,
    selected: labels.filter(l => l.classList.contains('checked') || l.querySelector('input')?.checked).map(l => l.querySelector('input').value),
    answer: type === 'fill' ? container.value.trim() : '' };
}

if (typeof module !== 'undefined') module.exports = { normalizeText, createMatcher, parseQuestion };
