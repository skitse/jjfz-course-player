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
  const [centerPath, catalogPath, playerPath] = options.routes ?? ['/jjfz/lesson', '/jjfz/lesson/video', '/jjfz/play'];
  const center = new URL(centerPath + '?stg=' + stage, origin);
  const scope = options.routes ? JSON.stringify([...options.routes, stage]) : stage;
  const queueKey = 'jjfz-course-player:queue:' + scope;
  const entries = [];
  const catalogs = new Map();

  function playerUrl(group, episode) {
    return playerPath + '?v_id=' + group + (episode ? '&r_id=' + episode : '') + '&r=video&stg=' + stage;
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
    return '<li><a href="' + catalogPath + '?stg=' + stage + '&lesson_id=' + id + '">'
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
    const listeners = new Map();
    const intervals = new Map();
    let reloads = 0;
    let now = 0;
    const player = new URL(href).pathname === playerPath;
    const html = markup ?? (player ? '<div class="vlist"><div class="vitem active"></div></div><video></video>' : centerHtml());
    const { document, Event } = parseHTML('<html><head></head><body>' + html + '</body></html>');
    const video = document.querySelector('video');
    if (video) Object.assign(video, { paused: true, ended: false, muted: false, readyState: 1, currentTime: 0,
      calls: 0, async play() { this.calls++; } });
    const addListener = document.addEventListener.bind(document);
    document.addEventListener = (type, fn, config) => {
      listeners.set(type, fn);
      addListener(type, fn, config);
    };
    let update;
    let timerId = 0;
    runInNewContext(source, {
      URL, document, DOMParser, AbortSignal, console, performance: { now: () => now },
      location: { href, assign: destination => visits.push(destination), reload: () => reloads++ },
      sessionStorage: {
        getItem: key => session.get(key),
        setItem: (key, value) => session.set(key, value),
        removeItem: key => session.delete(key),
      },
      GM_registerMenuCommand: (name, fn) => menu.set(name, fn),
      GM_getValue: (key, fallback) => prefs.has(key) ? prefs.get(key) : fallback,
      GM_setValue: (key, value) => prefs.set(key, value),
      prompt: () => options.promptAnswer ?? null,
      alert: message => { if (options.alerts) options.alerts.push(message); },
      MutationObserver: class { constructor(fn) { update = fn; } observe() {} },
      setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: id => timers.delete(id),
      setInterval: fn => { intervals.set(++timerId, fn); return timerId; },
      async fetch(url, config) {
        assert.equal(url.origin, origin);
        assert.equal(url.searchParams.get('stg'), stage);
        assert.equal(config.redirect, 'error');
        requests.push(url.href);
        if (url.pathname === centerPath) {
          return { ok: true, text: async () => centerHtml(url.searchParams.get('page') === '2') };
        }
        assert.equal(url.pathname, catalogPath);
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
      get reloads() { return reloads; },
      advanceClock(ms) {
        now += ms;
        for (const fn of intervals.values()) fn();
      },
      emit(type, options) {
        listeners.get(type)?.({ type, target: video, ...options });
      },
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

test('recovers foreground and background pauses without restarting a deliberate pause', async () => {
  const f = fixture('https://learning-a.example', '41', [[1]]);
  await f.load().menu.get(start)();
  const page = f.load(f.entries[0].href);
  const { video, document } = page;
  await page.flushTimers();
  assert.equal(video.calls, 1);

  video.paused = false;
  page.emit('playing');
  video.currentTime = 40;
  video.paused = true;
  page.emit('pause');
  await page.flushTimers();
  assert.equal(video.calls, 2);

  video.paused = false;
  page.emit('playing');
  video.currentTime = 41;
  video.paused = true;
  page.emit('pause');
  await page.flushTimers();
  assert.equal(video.calls, 2, 'a rapid repeat pause must not trigger a retry loop');

  video.paused = false;
  page.emit('playing');
  document.hidden = true;
  video.paused = true;
  page.emit('pause');
  await page.flushTimers();
  assert.equal(video.calls, 3);

  video.paused = false;
  page.emit('playing');
  video.paused = true;
  page.emit('pause');
  await page.flushTimers();
  assert.equal(video.calls, 3, 'background retries should also be bounded');

  assert.equal(page.showContinue(true), 1);
  video.paused = false;
  page.emit('playing');
  video.paused = true;
  page.emit('pause');
  await page.flushTimers();
  assert.equal(video.calls, 4, 'a new site confirmation starts a new recovery window');

  video.paused = false;
  page.emit('playing');
  video.currentTime = 49;
  page.emit('pointerdown', { isTrusted: true });
  video.paused = true;
  page.emit('pause');
  await page.flushTimers();
  assert.equal(video.calls, 4, 'the player pause control must still work');
});

test('starts the next video and handles completion and continue prompts in the background', async () => {
  const f = fixture('https://learning-a.example', '41', [[2]]);
  await f.load().menu.get(start)();
  const first = f.load(f.entries[0].href);
  first.document.hidden = true;
  assert.equal(first.showContinue(), 1);
  assert.equal(first.showContinue(true), 1);
  first.complete(true);
  assert.deepEqual(first.visits, [f.entries[1].href]);

  const second = f.load(f.entries[1].href);
  second.document.hidden = true;
  await second.flushTimers();
  assert.equal(second.video.calls, 1);
  second.complete(false);
  assert.deepEqual(second.visits, [f.center]);
});

test('defers recovery while an unfamiliar site dialog is visible', async () => {
  const f = fixture('https://learning-b.example', '7', [[1]]);
  await f.load().menu.get(start)();
  const page = f.load(f.entries[0].href);
  await page.flushTimers();
  page.video.paused = false;
  page.emit('playing');

  const dialog = page.document.createElement('div');
  dialog.className = 'layui-layer-dialog';
  dialog.getClientRects = () => [1];
  page.document.body.append(dialog);
  page.video.paused = true;
  page.emit('pause');
  await page.flushTimers();
  assert.equal(page.video.calls, 1);

  dialog.remove();
  page.emit('visibilitychange');
  await page.flushTimers();
  assert.equal(page.video.calls, 2);
});

test('reloads a stuck video at most twice and preserves the queue across reload', async () => {
  const f = fixture('https://learning-a.example', '41', [[1]]);
  await f.load().menu.get(start)();
  const href = f.entries[0].href;
  const before = f.session.get(f.queueKey);

  function stuck(time = 50) {
    const page = f.load(href);
    page.video.paused = false;
    page.video.currentTime = time;
    page.emit('playing');
    page.advanceClock(10000);
    return page;
  }

  const first = stuck();
  first.advanceClock(74000);
  assert.equal(first.reloads, 0);
  first.advanceClock(1000);
  assert.equal(first.reloads, 1);
  assert.equal(f.session.get(f.queueKey), before);

  const second = stuck();
  second.advanceClock(75000);
  assert.equal(second.reloads, 1);

  const third = stuck();
  third.advanceClock(75000);
  assert.equal(third.reloads, 0);
  assert.match(third.document.querySelector('[role=status]').textContent, /停止自动重载/);
  third.video.currentTime = 56;
  third.advanceClock(10000);
  third.advanceClock(75000);
  assert.equal(third.reloads, 1, 'real progress past the old stall should restore the retry budget');
});

test('recovers a background stall but resets its timer on visibility changes or resume', async () => {
  const f = fixture('https://learning-a.example', '41', [[1]]);
  await f.load().menu.get(start)();
  const page = f.load(f.entries[0].href);
  page.video.paused = false;
  page.emit('playing');
  page.advanceClock(10000);
  page.document.hidden = true;
  page.emit('visibilitychange');
  page.advanceClock(120000);
  page.emit('resume');
  page.advanceClock(120000);
  assert.equal(page.reloads, 0);
  page.video.paused = true;
  page.advanceClock(120000);
  assert.equal(page.reloads, 0);
  page.video.paused = false;
  page.emit('playing');
  page.advanceClock(10000);
  assert.equal(page.reloads, 0);
  page.advanceClock(75000);
  assert.equal(page.reloads, 1);
});

test('supports another origin, a different stage and course count, mute and rebuild', async () => {
  const f = fixture('https://learning-b.example', '72', [[1], [2, 1]]);
  const index = f.load();
  index.menu.get(mute)();
  await index.menu.get(start)();
  assert.equal(f.entries.length, 4);
  const first = f.load(f.entries[0].href);
  assert.equal(first.video.muted, true);
  first.video.muted = false;
  first.emit('volumechange');
  assert.equal(first.video.muted, true);
  assert.equal(first.showContinue(), 1);
  assert.equal(first.showContinue(true), 1);
  first.complete(true);
  const second = f.load(f.entries[1].href);
  assert.equal(second.video.muted, true);
  second.menu.get(unmute)();
  second.emit('volumechange');
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

test('starts at an open required video without claiming earlier videos', async () => {
  const f = fixture('https://learning-a.example', '23', [[1], [2, 1]]);
  const player = f.load(f.entries[2].href);
  await player.menu.get('从当前视频开始必修队列')();
  assert.deepEqual(JSON.parse(f.session.get(f.queueKey)).entries, f.entries.slice(2));
  assert.deepEqual(player.visits, []);
  assert.match(player.document.querySelector('[role=status]').textContent, /1\/2/);
});

test('rejects similar URLs, unapproved sites, wrong stages and malformed queue state', async () => {
  const f = fixture('https://learning-b.example', '72', [[1]]);
  assert.deepEqual([...f.load(f.center, '<h1>课程中心</h1>').menu.keys()], ['配置本站页面地址']);
  assert.deepEqual([...f.load(f.entries[0].href, '<video></video>').menu.keys()], ['配置本站页面地址']);

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

test('accepts user configured same-origin addresses and isolates separate queues', async () => {
  const origin = 'https://learning-a.example';
  const routes = ['/training/home', '/training/materials', '/watch'];
  const prefs = new Map();
  const session = new Map();
  const f = fixture(origin, '41', [[2]], {
    routes, prefs, session, promptAnswer: origin + routes[0] + '?stg=41\n' + routes.slice(1).join('\n'),
  });
  const settings = f.load();
  settings.menu.get('配置本站页面地址')();
  assert.equal(settings.reloads, 1);
  assert.deepEqual(Array.from(prefs.get('routes:' + origin)), routes);

  const customCenter = f.load();
  await customCenter.menu.get(start)();
  assert.deepEqual(customCenter.visits, [f.entries[0].href]);
  assert.ok(session.has(f.queueKey));
  assert.equal(session.has('jjfz-course-player:queue:41'), false);
  const video = f.load(f.entries[0].href);
  video.document.hidden = true;
  video.complete(true);
  assert.deepEqual(video.visits, [f.entries[1].href]);

  const alerts = [];
  const invalid = fixture(origin, '41', [[1]], {
    routes, prefs, alerts, promptAnswer: routes[0] + '\nhttps://other.example/materials\n' + routes[2],
  }).load();
  invalid.menu.get('配置本站页面地址')();
  assert.equal(alerts.length, 1);
  assert.equal(invalid.reloads, 0);
  assert.deepEqual(Array.from(prefs.get('routes:' + origin)), routes);
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
