const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { DOMParser, parseHTML } = require('linkedom');

const source = readFileSync(resolve(__dirname, '../jjfz-course-player.user.js'), 'utf8');
const start = '开始或继续全部必修视频';
const rebuild = '重新读取必修目录并开始';
const pause = '关闭此标签页的自动续播';
const mute = '静音播放（记住此站点）';
const unmute = '恢复声音（记住此站点）';
const shape = [
  [3, 27, 10, 1], [1, 3, 3], [1, 2, 2, 1], [1, 1, 1], [2, 3, 3],
  [3, 5, 2], [5, 1, 3], [6, 1, 1], [2, 1, 7], [1, 8, 7], [10, 6], [1], [2, 3],
];

function fixture(origin, stage, counts, options = {}) {
  const session = options.session ?? new Map();
  const prefs = options.prefs ?? new Map();
  const courseIds = counts.map((_, i) => i + 100);
  const center = new URL('/jjfz/lesson?stg=' + stage, origin);
  const queueKey = 'jjfz-course-player:queue:' + stage;
  const entries = [];
  const catalogs = new Map();

  function playerUrl(group, episode) {
    return '/jjfz/play?v_id=' + group + (episode ? '&r_id=' + episode : '') + '&r=video&stg=' + stage;
  }

  function card(group, count, course, bad = false, optional = false) {
    const main = playerUrl(group);
    const urls = Array.from({ length: count }, (_, i) => playerUrl(group, count > 1 ? group * 100 + i : 0));
    if (!optional) entries.push(...urls.map((href, i) => ({
      href: new URL(href, origin).href,
      title: count === 1 ? '课件 ' + group : '分集 ' + (i + 1),
      course,
    })));
    const episodes = count > 1 ? urls.slice(0, bad ? count - 1 : count).map((href, i) =>
      '<dd><a href="' + href + '">分集 ' + (i + 1) + '</a></dd>'
    ).join('') : '';
    return '<li><div class="l_list_right"><h2><a href="' + main + '">课件 ' + group
      + '</a></h2><div class="l_list_num">共 ' + count + ' 讲<span class="r_read">'
      + (optional ? ' 选 修 ' : ' 必 修 ') + '</span></div><dl>' + episodes + '</dl></div></li>';
  }

  const courseLinks = courseIds.map((id, i) => {
    const course = '课程 ' + id;
    const cards = counts[i].map((count, j) => card(id * 10 + j, count, course,
      options.malformed && i === counts.length - 1 && j === counts[i].length - 1
    ));
    catalogs.set(id, cards);
    return '<li><a href="/jjfz/lesson/video?stg=' + stage + '&lesson_id=' + id + '">'
      + course + '</a><dl><dd>已完成必读课件：0</dd><dd>必读课件：' + counts[i].length + '</dd></dl></li>';
  });

  const centerHtml = (secondPage = false) => '<ul>'
    + (options.paginated ? courseLinks.slice(secondPage ? 1 : 0, secondPage ? undefined : 1) : courseLinks).join('')
    + '</ul>' + (options.paginated && !secondPage ? '<a href="?stg=' + stage + '&page=2">下一页</a>' : '');

  function load(href = center.href, markup) {
    const menu = new Map();
    const visits = [];
    const requests = [];
    const timers = new Map();
    const player = new URL(href).pathname === '/jjfz/play';
    const html = markup ?? (player ? '<div class="vlist"><div class="vitem active"></div></div><video></video>' : centerHtml());
    const { document, Event } = parseHTML('<html><head></head><body>' + html + '</body></html>');
    const video = document.querySelector('video');
    if (video) Object.assign(video, { paused: true, ended: false, muted: false, readyState: 1,
      calls: 0, async play() { this.calls++; } });
    let update;
    let timerId = 0;
    runInNewContext(source, {
      URL, document, DOMParser, AbortSignal, console,
      location: { href, assign: destination => visits.push(destination) },
      sessionStorage: {
        getItem: key => session.get(key),
        setItem: (key, value) => session.set(key, value),
        removeItem: key => session.delete(key),
      },
      GM_registerMenuCommand: (name, fn) => menu.set(name, fn),
      GM_getValue: (key, fallback) => prefs.has(key) ? prefs.get(key) : fallback,
      GM_setValue: (key, value) => prefs.set(key, value),
      MutationObserver: class { constructor(fn) { update = fn; } observe() {} },
      setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: id => timers.delete(id),
      async fetch(url, config) {
        assert.equal(url.origin, origin);
        assert.equal(url.searchParams.get('stg'), stage);
        assert.equal(config.redirect, 'error');
        requests.push(url.href);
        if (url.pathname === '/jjfz/lesson') {
          return { ok: true, text: async () => centerHtml(url.searchParams.get('page') === '2') };
        }
        assert.equal(url.pathname, '/jjfz/lesson/video');
        assert.equal(url.searchParams.get('required'), '1');
        const id = Number(url.searchParams.get('lesson_id'));
        if (options.networkFailure && id === courseIds[1]) throw Error('Network failure');
        let cards = catalogs.get(id);
        let next = '';
        if (options.paginated && id === courseIds[0] && cards.length > 1) {
          if (url.searchParams.get('page') === '2') {
            cards = cards.slice(1);
          } else {
            cards = cards.slice(0, 1);
            const prefix = options.unsafePagination ? 'https://different.example/jjfz/lesson/video' : '';
            next = '<a href="' + prefix + '?stg=' + stage + '&lesson_id=' + id + '&required=1&page=2">下一页</a>';
          }
        }
        return { ok: true, text: async () => '<ul>' + cards.join('')
          + card(99999, 1, '', false, true) + '</ul>' + next };
      },
    });
    return {
      menu, visits, requests, timers, video, document,
      async flushTimers() {
        for (const [id, fn] of timers) {
          timers.delete(id);
          await fn();
        }
      },
      showContinue(timed = false) {
        const popup = document.createElement('div');
        popup.style.zIndex = '2147483000';
        popup.getClientRects = () => [1];
        popup.innerHTML = timed
          ? '<div><div>提示</div><div>视频已暂停，点击按钮后继续学习！</div><div><button>继续</button></div></div>'
          : '<div><div>继续观看</div><div>该视频已播放至 01:02</div><div><button>继续播放</button></div></div>';
        const button = popup.querySelector('button');
        let clicks = 0;
        button.addEventListener('click', () => clicks++);
        document.body.append(popup);
        update();
        update();
        popup.remove();
        return clicks;
      },
      complete(receiptFirst) {
        const note = document.createElement('div');
        note.className = 'layui-layer-dialog';
        note.innerHTML = '<div class="layui-layer-content">当前视频播放完毕！</div>';
        note.firstElementChild.getClientRects = () => [1];
        const ended = () => { video.ended = true; document.dispatchEvent(new Event('ended')); };
        const receipt = () => { document.body.append(note); update(); };
        const [first, second] = receiptFirst ? [receipt, ended] : [ended, receipt];
        first();
        assert.equal(visits.length, 0);
        second();
        update();
      },
    };
  }
  return { load, session, prefs, entries, queueKey, center: center.href };
}

test('walks all 140 episodes across courses, catalog pages and receipts in either order', async () => {
  const f = fixture('http://learning-a.example', '41', shape, { paginated: true });
  const index = f.load();
  await index.menu.get(start)();
  assert.equal(index.requests.length, 15);
  assert.equal(f.entries.length, 140);
  assert.deepEqual(JSON.parse(f.session.get(f.queueKey)).entries, f.entries);
  assert.deepEqual(index.visits, [f.entries[0].href]);
  for (const [i, entry] of f.entries.entries()) {
    const page = f.load(entry.href);
    page.complete(i % 2 === 0);
    assert.deepEqual(page.visits, [f.entries[i + 1]?.href ?? f.center]);
    assert.equal(JSON.parse(f.session.get(f.queueKey)).index, i + 1);
  }
  assert.match(f.load().document.querySelector('[role=status]').textContent, /队列已结束 · 140/);
});

test('supports another origin, a different stage and course count, mute and rebuild', async () => {
  const f = fixture('https://learning-b.example', '72', [[1], [2, 1]]);
  const index = f.load();
  index.menu.get(mute)();
  await index.menu.get(start)();
  assert.equal(f.entries.length, 4);
  const first = f.load(f.entries[0].href);
  assert.equal(first.video.muted, true);
  assert.equal(first.showContinue(), 1);
  assert.equal(first.showContinue(true), 1);
  first.complete(true);
  const second = f.load(f.entries[1].href);
  assert.equal(second.video.muted, true);
  second.menu.get(unmute)();
  assert.equal(second.video.muted, false);
  second.menu.get(pause)();
  await second.flushTimers();
  assert.equal(second.video.calls, 0);
  const center = f.load();
  await center.menu.get(start)();
  assert.deepEqual(center.visits, [f.entries[1].href]);
  const newIndex = f.load();
  await newIndex.menu.get(rebuild)();
  assert.deepEqual(newIndex.visits, [f.entries[0].href]);
  assert.equal(f.load(f.entries[0].href).video.muted, false);
});

test('rejects similar URLs, unapproved sites, wrong stages and malformed queue state', async () => {
  const f = fixture('https://learning-b.example', '72', [[1]]);
  assert.equal(f.load(f.center, '<h1>课程中心</h1>').menu.size, 0);
  assert.equal(f.load(f.entries[0].href, '<video></video>').menu.size, 0);

  f.session.set(f.queueKey, JSON.stringify({ entries: f.entries, index: 0, running: true }));
  assert.equal(f.load(f.entries[0].href).timers.size, 0);

  await f.load().menu.get(start)();
  const alternate = f.load(f.entries[0].href.replace('stg=72', 'stg=73'));
  assert.equal(alternate.timers.size, 0);

  f.session.set(f.queueKey, '{"entries":null}');
  assert.equal(f.load(f.entries[0].href).timers.size, 0);

  const crossSite = { ...f.entries[0], href: f.entries[0].href.replace('learning-b', 'different') };
  f.session.set(f.queueKey, JSON.stringify({ entries: [crossSite], index: 0, running: true }));
  assert.equal(f.load(f.entries[0].href).timers.size, 0);
});

test('preserves the previous queue when the rebuilt catalog fails validation', async () => {
  const origin = 'https://learning-c.example';
  const original = fixture(origin, '17', [[1, 2], [3]]);
  await original.load().menu.get(start)();
  const previous = original.session.get(original.queueKey);
  for (const failure of [{ malformed: true }, { networkFailure: true }, { paginated: true, unsafePagination: true }]) {
    const f = fixture(origin, '17', [[1, 2], [3]], { ...failure, session: original.session, prefs: original.prefs });
    const index = f.load();
    await index.menu.get(rebuild)();
    assert.deepEqual(index.visits, []);
    assert.match(index.document.querySelector('[role=status]').textContent, /队列未启动/);
    assert.equal(f.session.get(f.queueKey), previous);
  }
});
