import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GTC = require('../src/lib.js');

test('parseTimestamp accepts player timestamps and human units', () => {
  assert.equal(GTC.parseTimestamp(0), 0);
  assert.equal(GTC.parseTimestamp(2675), 2675);
  assert.equal(GTC.parseTimestamp('44:35'), 2675);
  assert.equal(GTC.parseTimestamp('1:02:03'), 3723);
  assert.equal(GTC.parseTimestamp('01:02:03.5'), 3723.5);
  assert.equal(GTC.parseTimestamp('84:42'), 5082);
  assert.equal(GTC.parseTimestamp('1小时2分3秒'), 3723);
  assert.equal(GTC.parseTimestamp('2分3秒'), 123);
  assert.equal(GTC.parseTimestamp('90秒'), 90);
  assert.equal(GTC.parseTimestamp('1h2m3s'), 3723);
  assert.equal(GTC.parseTimestamp(' 1 hr 2 min 3 sec '), 3723);
  assert.equal(GTC.parseTimestamp('  0:27  '), 27);

  assert.equal(GTC.parseTimestamp(null), null);
  assert.equal(GTC.parseTimestamp(''), null);
  assert.equal(GTC.parseTimestamp('abc'), null);
  assert.equal(GTC.parseTimestamp('1:75'), null);
  assert.equal(GTC.parseTimestamp('1:02:75'), null);
  assert.equal(GTC.parseTimestamp(-1), null);
  assert.equal(GTC.parseTimestamp('86401'), null);
});

test('formatTime keeps the GCORES-style short clock', () => {
  assert.equal(GTC.formatTime(0), '0:00');
  assert.equal(GTC.formatTime(27), '0:27');
  assert.equal(GTC.formatTime(2675), '44:35');
  assert.equal(GTC.formatTime(3723), '1:02:03');
  assert.equal(GTC.formatTime('1:02:03'), '1:02:03');
  assert.equal(GTC.formatTime('nope'), '--:--');
});

test('formatTimeLong is usable in accessible names', () => {
  assert.equal(GTC.formatTimeLong(27), '27 秒');
  assert.equal(GTC.formatTimeLong(3723), '1 小时 2 分 3 秒');
  assert.equal(GTC.formatTimeLong(60), '1 分');
  assert.equal(GTC.formatTimeLong('nope'), '未知时间');
});

test('toPlainText turns API markup into safe readable text', () => {
  const html =
    '<p>Hello &amp; <strong>world</strong></p><p>第二行&nbsp;ok &#x1f3a7;</p><br>尾巴';
  assert.equal(
    GTC.toPlainText(html),
    'Hello & world\n第二行 ok 🎧\n尾巴'
  );
  assert.equal(GTC.toPlainText(null), '');
});

test('timestamp prefixes are removed from comment bodies', () => {
  assert.equal(GTC.stripTimestampPrefix('44:35 还有《燃烧肖像的女子》！'), '还有《燃烧肖像的女子》！');
  assert.equal(GTC.stripTimestampPrefix('00:27 关于这个节目'), '关于这个节目');
  assert.equal(GTC.stripTimestampPrefix('1:02:03 - 这段很好'), '这段很好');
  assert.equal(GTC.stripTimestampPrefix('没有时间戳的评论'), '没有时间戳的评论');
  assert.equal(GTC.stripTimestampPrefix('90秒'), '90秒');
});

function radioFixture() {
  return {
    data: {
      type: 'radios',
      id: '221133',
      attributes: { duration: 5082, title: '怀念刘欢' },
      relationships: { media: { data: { type: 'medias', id: 'media-1' } } },
    },
    included: [
      {
        type: 'medias',
        id: 'media-1',
        attributes: { duration: 5082.84 },
        relationships: { timelines: { data: [{ type: 'timelines', id: 'timeline-1' }] } },
      },
      {
        type: 'timelines',
        id: 'timeline-1',
        attributes: {
          at: 84,
          title: '开场',
          content: '<p>这是<strong>时间轴</strong>内容</p>',
          'comments-count': 4,
        },
      },
      {
        type: 'timelines',
        id: 'timeline-2',
        attributes: { at: 120, title: '不应出现的其他媒体时间轴' },
      },
      {
        type: 'timelines',
        id: 'timeline-3',
        attributes: { at: 'bad', title: '无效时间' },
      },
    ],
  };
}

test('extractDuration prefers the radio duration and falls back to media', () => {
  assert.equal(GTC.extractDuration(radioFixture()), 5082);
  const noRadioDuration = radioFixture();
  delete noRadioDuration.data.attributes.duration;
  assert.equal(GTC.extractDuration(noRadioDuration), 5082.84);
  assert.equal(GTC.extractDuration(null), 0);
});

test('extractTimelineEntries follows the media timeline relationship', () => {
  const entries = GTC.extractTimelineEntries(radioFixture());
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: 'timeline-1',
    kind: 'timeline',
    at: 84,
    title: '开场',
    content: '这是时间轴内容',
    author: '',
    commentsCount: 4,
    createdAt: '',
  });
});

test('extractTimelineEntries still works when relationships are absent', () => {
  const payload = radioFixture();
  payload.included[0].relationships = {};
  const entries = GTC.extractTimelineEntries(payload);
  assert.equal(entries.length, 2);
});

test('extractTimestampedComments skips null times and joins users', () => {
  const payload = {
    data: [
      {
        type: 'comments',
        id: '6453121',
        attributes: {
          body: '<p>44:35 还有《燃烧肖像的女子》！</p>',
          'radio-timestamp': 2675,
        },
        relationships: { user: { data: { type: 'users', id: 'user-1' } } },
      },
      {
        type: 'comments',
        id: '6453000',
        attributes: { body: '没有时间戳', 'radio-timestamp': null },
      },
    ],
    included: [
      {
        type: 'users',
        id: 'user-1',
        attributes: { nickname: '听友 A' },
      },
    ],
  };

  const entries = GTC.extractTimestampedComments(payload);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: '6453121',
    kind: 'comment',
    at: 2675,
    title: '',
    content: '还有《燃烧肖像的女子》！',
    author: '听友 A',
    commentsCount: 0,
    createdAt: '',
  });
});

test('mergeEntries filters out-of-range times and de-duplicates', () => {
  const entries = [
    { id: 'a', kind: 'comment', at: 30, body: 'a' },
    { id: 'a', kind: 'comment', at: 30, body: 'duplicate' },
    { id: 'b', kind: 'comment', at: 100.2, body: 'within tolerance' },
    { id: 'c', kind: 'comment', at: 100.3, body: 'outside tolerance' },
    { id: 'd', kind: 'timeline', at: 50 },
    { id: 'e', kind: 'comment', at: null },
  ];
  const merged = GTC.mergeEntries(entries, 100);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['a', 'd', 'b']
  );
});

test('groupEntries merges markers that would overlap on screen', () => {
  const entries = [
    { id: 'a', kind: 'comment', at: 0, content: 'a' },
    { id: 'b', kind: 'comment', at: 1, content: 'b' },
    { id: 'c', kind: 'comment', at: 3, content: 'c' },
    { id: 'd', kind: 'comment', at: 40, content: 'd' },
    { id: 'e', kind: 'comment', at: 40, content: 'e' },
  ];
  const groups = GTC.groupEntries(entries, 100, 100, 10);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].entries.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal(groups[0].at, 0);
  assert.deepEqual(groups[1].entries.map((entry) => entry.id), ['d', 'e']);
});

test('groupEntries keeps distant entries separate on a long radio', () => {
  const entries = [
    { id: 'a', kind: 'comment', at: 27, content: 'a' },
    { id: 'b', kind: 'comment', at: 680, content: 'b' },
    { id: 'c', kind: 'comment', at: 2675, content: 'c' },
  ];
  const groups = GTC.groupEntries(entries, 3599, 800, 12);
  assert.equal(groups.length, 3);
});

test('accessible labels describe time, kind, summary and action', () => {
  const single = GTC.groupEntries(
    [{ id: 'a', kind: 'comment', at: 27, content: '关于这个节目', author: '听友' }],
    3599,
    800
  )[0];
  const label = GTC.clusterAccessibleLabel(single);
  assert.match(label, /27 秒/);
  assert.match(label, /评论/);
  assert.match(label, /@听友/);
  assert.match(label, /按回车跳转/);

  const grouped = GTC.groupEntries(
    [
      { id: 'a', kind: 'comment', at: 10, content: '第一条', author: 'A' },
      { id: 'b', kind: 'timeline', at: 12, title: '第二章', content: '第二条' },
    ],
    3599,
    800,
    20
  )[0];
  const groupedLabel = GTC.clusterAccessibleLabel(grouped);
  assert.match(groupedLabel, /共 2 条/);
  assert.match(groupedLabel, /0:10/);
  assert.match(groupedLabel, /第二章/);
});

test('excerpt collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(GTC.excerpt('  a\n\n b  ', 20), 'a b');
  assert.equal(GTC.excerpt('abcdefghij', 5), 'abcd…');
});
