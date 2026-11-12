const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const bank = JSON.parse(fs.readFileSync(path.join(root, 'data/questions.json'))).questions;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const selected = [
  ...bank.filter(q => q.type === 'single').slice(0, 8),
  ...bank.filter(q => q.type === 'multiple').slice(0, 5),
  ...bank.filter(q => q.type === 'boolean').slice(0, 4),
  ...bank.filter(q => q.type === 'fill').slice(0, 2),
  { type: 'single', question: '本地模拟题：题库没有收录这道新题。', options: ['新选项甲', '新选项乙'] }
];
let questions, events;
function reset() {
  questions = selected.map((q, i) => ({ ...q, options: [...q.options].reverse(), index: i + 1,
    qid: String(1000 + i), chosen: i === 0 ? ['10000'] : [], answer: '' }));
  events = [];
}
reset();
function questionHtml(q) {
  const type = { single: '单选题', multiple: '多选题', boolean: '判断题', fill: '填空题' }[q.type];
  const title = `<div class="e_cont_title"><span>${type}</span></div><h2 class="exam_h2">${q.index}. ${escape(q.question)}</h2>`;
  if (q.type === 'fill') return title + `<input class="summary_question" qindex="${q.index}" qid="${q.qid}" value="${escape(q.answer)}">`;
  return title + `<ul class="${q.type === 'multiple' ? 'answer_list_box' : 'answer_list'}" qindex="${q.index}" qid="${q.qid}">`
    + q.options.map((text, i) => `<li><label class="${q.chosen.includes(q.qid + i) ? 'checked' : ''}"><input type="${q.type === 'multiple' ? 'checkbox' : 'radio'}" qid="${q.qid}" value="${q.qid + i}">${escape(text)}</label></li>`).join('') + '</ul>';
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reply = (type, body, status = 200) => { res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (url.pathname === '/bundle.js') return reply('application/javascript', fs.readFileSync(path.join(root, 'jjfz-course-player.user.js')));
  if (url.pathname === '/state') return reply('application/json', JSON.stringify({ questions, events }));
  if (url.pathname === '/reset' && req.method === 'POST') { reset(); return reply('application/json', '{"ok":true}'); }
  if (url.pathname.endsWith('/get_question')) {
    const q = questions[Number(url.searchParams.get('i')) - 1];
    return reply('text/html', q ? questionHtml(q) : '', q ? 200 : 404);
  }
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const values = new URLSearchParams(body);
    events.push({ path: url.pathname, index: values.get('i') });
    if (url.pathname.endsWith('/answer')) {
      const q = questions[Number(values.get('i')) - 1];
      if (!q || q.qid !== values.get('qid') || values.get('_xsrf') !== 'local-fixture') return reply('application/json', '{"code":0}', 400);
      if (q.type === 'fill') q.answer = values.get('answer');
      else q.chosen = values.get('answer').split('|');
    }
    return reply('application/json', '{"code":1}');
  }
  if (url.pathname !== '/jjfz/lesson/exam') return reply('text/plain', 'Not found', 404);
  reply('text/html', `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地模拟章节自测</title></head><body style="font:16px/1.6 sans-serif;margin:24px;max-width:700px">
    <h1>本地模拟章节自测</h1><p>20 题，选项已重排。第 1 题已有作答，第 20 题为新题。所有保存均在本地模拟。</p>
    <input name="_xsrf" type="hidden" value="local-fixture"><div class="exam_cont_left">${questionHtml(questions[0])}</div>
    <div class="exam_num_lists"><ul style="display:flex;gap:12px;flex-wrap:wrap;list-style:none;padding:0">${questions.map(q => `<li id="${q.qid}" style="cursor:pointer">${q.index}</li>`).join('')}</ul></div>
    <button id="submit_exam">模拟网站交卷按钮</button><div id="commands"></div>
    <script>
    window.GM_getValue=(k,d)=>{const v=localStorage.getItem('fixture:'+k);return v===null?d:JSON.parse(v)};
    window.GM_setValue=(k,v)=>localStorage.setItem('fixture:'+k,JSON.stringify(v));
    window.GM_registerMenuCommand=(name,fn)=>{const b=document.createElement('button');b.textContent=name;b.onclick=fn;document.getElementById('commands').append(b)};
    document.querySelectorAll('.exam_num_lists li').forEach((li,i)=>li.onclick=async()=>{document.querySelector('.exam_cont_left').innerHTML=await(await fetch('/jjfz/lesson/exam/get_question?stg=51&lesson_id=12&i='+(i+1))).text()});
    document.getElementById('submit_exam').onclick=()=>fetch('/jjfz/lesson/exam/submit',{method:'POST'});
    </script><script src="/bundle.js"></script></body></html>`);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/jjfz/lesson/exam?lesson_id=12&stg=51` })));
