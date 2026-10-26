/**
 * tests/media-catalog.test.js
 * 覆盖：八个渠道类型齐全、目录条数与结构、平台覆盖、类型过滤、搜索（名称 / 备注 / 域名、
 * 大小写不敏感）、排序（aiCited 降序 + 名称升序）、api / webhook / browser / manual
 * 四种就绪判断与升级、缺密钥的中文 reason、成本估算（单条 / 多条 / count 放大 / 混合 / 空输入）、
 * Markdown 表格表头与行数、单元格转义、纯函数确定性与目录不可污染。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_TYPES,
  MEDIA_CATALOG,
  listMedia,
  mediaReadiness,
  estimateCost,
  renderMediaTable,
} from '../lib/media-catalog.js';

/** 按 id 取目录条目，找不到直接让测试失败，避免静默跳过。 */
function byId(id) {
  const media = MEDIA_CATALOG.find((item) => item.id === id);
  assert.ok(media, `目录里应当有 ${id}`);
  return media;
}

/** 中文名比较，和实现保持同一口径，用于校验排序。 */
function compareName(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN');
}

test('MEDIA_TYPES 八个类型齐全且顺序固定', () => {
  assert.deepEqual([...MEDIA_TYPES], [
    '中央媒体',
    '门户网站',
    '行业垂直',
    '地方媒体',
    '自媒体平台',
    '问答社区',
    '视频平台',
    '自媒体矩阵',
  ]);
  assert.ok(Object.isFrozen(MEDIA_TYPES), '类型常量应冻结，避免运行时被改写');
});

test('MEDIA_CATALOG 二十条左右，字段完整且 id 唯一', () => {
  assert.ok(MEDIA_CATALOG.length >= 20 && MEDIA_CATALOG.length <= 24, `条数应合理，实际 ${MEDIA_CATALOG.length}`);
  assert.equal(MEDIA_CATALOG.length, 23);
  assert.ok(Object.isFrozen(MEDIA_CATALOG), '目录应冻结，避免运行时被改写');

  const ids = new Set();
  const modes = ['api', 'webhook', 'browser', 'manual'];
  const speeds = ['fast', 'normal', 'slow'];

  for (const media of MEDIA_CATALOG) {
    assert.equal(typeof media.id, 'string');
    assert.ok(media.id.length > 0);
    assert.ok(!ids.has(media.id), `id 不能重复：${media.id}`);
    ids.add(media.id);

    assert.ok(MEDIA_TYPES.includes(media.type), `${media.id} 的类型 ${media.type} 应在 MEDIA_TYPES 内`);
    assert.ok(Array.isArray(media.domains), `${media.id} 的 domains 应是数组`);
    for (const domain of media.domains) {
      assert.ok(!domain.startsWith('http'), `${media.id} 的域名不应带协议：${domain}`);
      assert.equal(domain, domain.toLowerCase());
    }

    assert.ok(modes.includes(media.publishMode), `${media.id} 的发布方式非法`);
    assert.ok(speeds.includes(media.indexSpeed), `${media.id} 的收录速度非法`);
    assert.equal(typeof media.aiCited, 'boolean');
    assert.equal(typeof media.note, 'string');
    assert.ok(media.note.length > 0, `${media.id} 必须有中文备注`);

    // 价格是公开市场经验值估算，必须落在 ¥0-3000 且下限不高于上限。
    assert.ok(media.priceMin >= 0 && media.priceMax <= 3000, `${media.id} 价格超出估算区间`);
    assert.ok(media.priceMin <= media.priceMax, `${media.id} 价格下限不能高于上限`);

    if (media.envKey !== undefined) {
      assert.match(media.envKey, /^PUBLISH_[A-Z0-9_]+_WEBHOOK$/, `${media.id} 的 envKey 命名不符约定`);
    }
  }
});

test('目录覆盖任务要求的平台，且每个类型都有渠道', () => {
  const names = MEDIA_CATALOG.map((media) => media.name);
  for (const required of [
    '知乎',
    '微信公众号',
    '今日头条',
    '百家号',
    '搜狐号',
    '网易号',
    '新浪看点',
    '小红书',
    '抖音',
    'B站',
    '微博',
    '36氪',
    '虎嗅',
    '亿邦动力',
    '芜湖新闻网',
    '百度知道',
    '视频号',
  ]) {
    assert.ok(names.includes(required), `目录应包含 ${required}`);
  }

  // 「百度百家」是百家号的旧称，不重复建条目，改在备注里交代清楚。
  assert.ok(byId('baijiahao').note.includes('百度百家'));

  for (const type of MEDIA_TYPES) {
    assert.ok(MEDIA_CATALOG.some((media) => media.type === type), `类型 ${type} 至少要有一条渠道`);
  }

  // 问答社区 / 视频平台 / 行业垂直的任务点名渠道必须落到正确类型。
  assert.equal(byId('zhihu').type, '问答社区');
  assert.equal(byId('baidu-zhidao').type, '问答社区');
  assert.equal(byId('douyin').type, '视频平台');
  assert.equal(byId('bilibili').type, '视频平台');
  assert.equal(byId('ebrun').type, '行业垂直');
});

test('listMedia 按类型精确过滤', () => {
  const qa = listMedia({ type: '问答社区' });
  assert.equal(qa.length, 2);
  assert.ok(qa.every((media) => media.type === '问答社区'));
  assert.deepEqual(qa.map((media) => media.id).sort(), ['baidu-zhidao', 'zhihu']);

  const video = listMedia({ type: '视频平台' });
  assert.equal(video.length, 3);
  assert.ok(video.every((media) => media.type === '视频平台'));

  // 精确匹配：给一个前缀不该把 自媒体平台 / 自媒体矩阵 一起捞出来。
  assert.deepEqual(listMedia({ type: '自媒体' }), []);
  assert.deepEqual(listMedia({ type: '不存在的类型' }), []);
});

test('listMedia 空参数返回全量，且结果按 aiCited 降序再按名称升序', () => {
  const all = listMedia();
  assert.equal(all.length, MEDIA_CATALOG.length);

  for (let index = 1; index < all.length; index += 1) {
    const prev = all[index - 1];
    const curr = all[index];
    // 常被 AI 引用的渠道排在前面。
    if (prev.aiCited === curr.aiCited) {
      assert.ok(compareName(prev.name, curr.name) <= 0, `${prev.name} 应排在 ${curr.name} 之前`);
    } else {
      assert.ok(prev.aiCited, `${curr.name}（非常引）不能排在 ${prev.name}（常引）前面`);
    }
  }

  const first = all[0];
  assert.equal(first.aiCited, true);
  assert.equal(all[all.length - 1].aiCited, false);
});

test('listMedia 搜索命中名称、备注与域名，且不区分大小写', () => {
  // 名称命中
  const byName = listMedia({ search: '知乎' });
  assert.ok(byName.some((media) => media.id === 'zhihu'));
  assert.ok(byName.every((media) => `${media.name}${media.note}${media.domains.join(' ')}`.includes('知乎')));

  // 备注命中（只在 note 里出现的关键词）
  const byNote = listMedia({ search: '高赞' });
  assert.deepEqual(byNote.map((media) => media.id), ['zhihu']);

  // 域名命中
  const byDomain = listMedia({ search: 'wuhunews.cn' });
  assert.deepEqual(byDomain.map((media) => media.id), ['wuhu-news']);

  // 大小写不敏感：域名与英文名都试一遍
  assert.deepEqual(listMedia({ search: 'BAIJIAHAO' }).map((media) => media.id), ['baijiahao']);
  assert.deepEqual(listMedia({ search: 'Bilibili' }).map((media) => media.id), ['bilibili']);
  assert.deepEqual(listMedia({ search: '36KR' }).map((media) => media.id), ['36kr']);

  // 搜不到时返回空数组而不是全量
  assert.deepEqual(listMedia({ search: '这个词一定不存在' }), []);
});

test('listMedia 的类型与搜索可叠加使用', () => {
  const result = listMedia({ type: '视频平台', search: 'B站' });
  assert.deepEqual(result.map((media) => media.id), ['bilibili']);

  const both = listMedia({ type: '问答社区', search: '百度' });
  assert.deepEqual(both.map((media) => media.id), ['baidu-zhidao']);

  // 类型对但关键词不命中 → 空
  assert.deepEqual(listMedia({ type: '视频平台', search: '知乎' }), []);
});

test('mediaReadiness：api 渠道配了密钥才就绪', () => {
  const wechat = byId('wechat');
  assert.equal(wechat.publishMode, 'api');

  assert.deepEqual(mediaReadiness(wechat, {}), {
    ready: false,
    mode: 'api',
    reason: '未配置 PUBLISH_WECHAT_WEBHOOK',
  });

  assert.deepEqual(mediaReadiness(wechat, { PUBLISH_WECHAT_WEBHOOK: 'https://qyapi.example.com/hook' }), {
    ready: true,
    mode: 'api',
  });

  // 空白字符串等于没配
  assert.deepEqual(mediaReadiness(wechat, { PUBLISH_WECHAT_WEBHOOK: '   ' }), {
    ready: false,
    mode: 'api',
    reason: '未配置 PUBLISH_WECHAT_WEBHOOK',
  });
});

test('mediaReadiness：webhook 渠道配了地址即升级为 api', () => {
  const toutiao = byId('toutiao');
  assert.equal(toutiao.publishMode, 'webhook');

  assert.deepEqual(mediaReadiness(toutiao, {}), {
    ready: false,
    mode: 'webhook',
    reason: '未配置 PUBLISH_TOUTIAO_WEBHOOK',
  });

  assert.deepEqual(mediaReadiness(toutiao, { PUBLISH_TOUTIAO_WEBHOOK: 'https://hook.example.com/toutiao' }), {
    ready: true,
    mode: 'api',
  });
});

test('mediaReadiness：browser 渠道默认可用并提示 Chrome 调试端口', () => {
  const zhihu = byId('zhihu');
  assert.equal(zhihu.publishMode, 'browser');

  assert.deepEqual(mediaReadiness(zhihu, {}), {
    ready: true,
    mode: 'browser',
    hint: '需要 Chrome 调试端口',
  });

  // 配了该渠道的 webhook 就升级成 api，不用再开浏览器
  assert.deepEqual(mediaReadiness(zhihu, { PUBLISH_ZHIHU_WEBHOOK: 'https://hook.example.com/zhihu' }), {
    ready: true,
    mode: 'api',
  });
});

test('mediaReadiness：manual 渠道永远就绪，未知方式不猜', () => {
  const renmin = byId('renmin');
  assert.equal(renmin.publishMode, 'manual');
  assert.deepEqual(mediaReadiness(renmin, {}), { ready: true, mode: 'manual' });
  // 哪怕环境里塞了无关密钥，人工渠道也不会被误判成 api
  assert.deepEqual(mediaReadiness(renmin, { PUBLISH_RENMIN_WEBHOOK: 'https://hook.example.com/x' }), {
    ready: true,
    mode: 'manual',
  });

  assert.deepEqual(mediaReadiness({ id: 'x', publishMode: 'carrier-pigeon' }, {}), {
    ready: false,
    mode: 'unknown',
    reason: '未知发布方式：carrier-pigeon',
  });

  // 空对象 / null 不崩
  assert.deepEqual(mediaReadiness(null, {}), { ready: false, mode: 'unknown', reason: '渠道不存在' });
  assert.deepEqual(mediaReadiness(undefined), { ready: false, mode: 'unknown', reason: '渠道不存在' });
});

test('estimateCost 单条渠道按单篇价格估算', () => {
  const result = estimateCost([byId('zhihu')], { count: 1 });
  assert.deepEqual(result.items, [{ id: 'zhihu', name: '知乎', count: 1, min: 50, max: 300 }]);
  assert.equal(result.totalMin, 50);
  assert.equal(result.totalMax, 300);
  assert.equal(result.mixed, false);
});

test('estimateCost 多条渠道累加区间', () => {
  const result = estimateCost([byId('zhihu'), byId('toutiao')]);
  assert.equal(result.items.length, 2);
  assert.equal(result.totalMin, 50); // 50 + 0
  assert.equal(result.totalMax, 500); // 300 + 200
  assert.equal(result.mixed, true, '含 0 元起投的头条，应标记为混合');
});

test('estimateCost 的 count 会同时放大每条与总额，非法篇数按 1 兜底', () => {
  const result = estimateCost([byId('zhihu')], { count: 3 });
  assert.deepEqual(result.items[0], { id: 'zhihu', name: '知乎', count: 3, min: 150, max: 900 });
  assert.equal(result.totalMin, 150);
  assert.equal(result.totalMax, 900);

  for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined]) {
    const fallback = estimateCost([byId('zhihu')], { count: bad });
    assert.equal(fallback.items[0].count, 1, `count=${String(bad)} 应兜底为 1`);
    assert.equal(fallback.totalMin, 50);
    assert.equal(fallback.totalMax, 300);
  }

  // 小数篇数向下取整，不产生半篇报价
  const floored = estimateCost([byId('zhihu')], { count: 2.8 });
  assert.equal(floored.items[0].count, 2);
  assert.equal(floored.items[0].max, 600);
});

test('estimateCost 混合标记与空输入', () => {
  const zeroCost = estimateCost([byId('wechat')]);
  assert.deepEqual(zeroCost.items[0], { id: 'wechat', name: '微信公众号', count: 1, min: 0, max: 0 });
  assert.equal(zeroCost.totalMin, 0);
  assert.equal(zeroCost.totalMax, 0);
  assert.equal(zeroCost.mixed, true, '零成本渠道也算混合');

  const paidOnly = estimateCost([byId('zhihu'), byId('36kr')]);
  assert.equal(paidOnly.mixed, false);
  assert.equal(paidOnly.totalMin, 550);

  assert.deepEqual(estimateCost(), { items: [], totalMin: 0, totalMax: 0, mixed: false });
  assert.deepEqual(estimateCost(null), { items: [], totalMin: 0, totalMax: 0, mixed: false });
  assert.deepEqual(estimateCost([]), { items: [], totalMin: 0, totalMax: 0, mixed: false });
  // 列表里混入脏数据不该让整次报价崩掉
  assert.deepEqual(estimateCost([null, undefined, 'x']).items, []);
});

test('renderMediaTable 输出七列表头且行数与输入一致', () => {
  const qa = listMedia({ type: '问答社区' });
  const table = renderMediaTable(qa);
  const lines = table.trimEnd().split('\n');

  assert.equal(lines[0], '| 渠道 | 类型 | 发布方式 | 单篇成本 | 收录速度 | AI 常引 | 备注 |');
  assert.equal(lines[1], '| --- | --- | --- | --- | --- | --- | --- |');
  assert.equal(lines.length, 2 + qa.length);

  const zhihuRow = lines.find((line) => line.startsWith('| 知乎 |'));
  assert.ok(zhihuRow, '表格里应有知乎这一行');
  assert.ok(zhihuRow.includes('| 问答社区 |'));
  assert.ok(zhihuRow.includes('| 浏览器 |'));
  assert.ok(zhihuRow.includes('| ¥50-300 |'));
  assert.ok(zhihuRow.includes('| 快 |'));
  assert.ok(zhihuRow.includes('| 是 |'));
  assert.ok(table.endsWith('\n'), '非空表格以换行结尾，方便直接拼进报告');
});

test('renderMediaTable 正确渲染零成本、人工与非常引渠道', () => {
  const table = renderMediaTable([byId('wechat'), byId('renmin')]);
  const lines = table.trimEnd().split('\n');
  assert.equal(lines.length, 4);

  const wechatRow = lines[2];
  assert.ok(wechatRow.startsWith('| 微信公众号 | 自媒体平台 | API |'));
  assert.ok(wechatRow.includes('| ¥0 |'), '零成本只写一个 ¥0');

  const renminRow = lines[3];
  assert.ok(renminRow.includes('| 人工 |'));
  assert.ok(renminRow.includes('| ¥800-3000 |'));

  const noCite = renderMediaTable([byId('weibo')]).trimEnd().split('\n')[2];
  assert.ok(noCite.includes('| 否 |'), '非常引渠道应显示「否」');
});

test('renderMediaTable 空输入不崩，单元格会转义竖线与换行', () => {
  assert.equal(renderMediaTable([]), '暂无渠道');
  assert.equal(renderMediaTable(), '暂无渠道');
  assert.equal(renderMediaTable(null), '暂无渠道');
  assert.equal(renderMediaTable([null, 'x']), '暂无渠道');

  const dirty = renderMediaTable([
    {
      id: 'dirty',
      name: '含|竖线',
      type: '问答社区',
      publishMode: 'manual',
      priceMin: 0,
      priceMax: 0,
      indexSpeed: 'fast',
      aiCited: false,
      note: '第一行\n第二行',
    },
  ]);
  const row = dirty.trimEnd().split('\n')[2];
  assert.ok(row.includes('含\\|竖线'), '竖线必须转义，否则会拆坏表格');
  assert.ok(row.includes('第一行 第二行'));
  assert.ok(!row.includes('\n'));
});

test('目录不做效果承诺，aiCited=true 必须有可辩护的「AI 常引用」表述', () => {
  for (const media of MEDIA_CATALOG) {
    assert.ok(!/保证/.test(media.note), `${media.id} 的备注不能写「保证」`);
    assert.ok(!/保证/.test(media.name));
    if (media.aiCited) {
      assert.ok(media.note.includes('AI 常引用'), `${media.id} 宣称 aiCited 时备注要写明「AI 常引用」`);
    }
  }
  // 至少覆盖四种发布方式，保证就绪判断的分支都有真实样本
  const modes = new Set(MEDIA_CATALOG.map((media) => media.publishMode));
  assert.deepEqual([...modes].sort(), ['api', 'browser', 'manual', 'webhook']);
});

test('纯函数：重复调用结果一致，且返回值不会污染内置目录', () => {
  assert.deepEqual(listMedia({ type: '自媒体平台' }), listMedia({ type: '自媒体平台' }));
  assert.deepEqual(estimateCost([byId('zhihu')]), estimateCost([byId('zhihu')]));

  const first = listMedia({ search: '知乎' });
  const second = listMedia({ search: '知乎' });
  assert.deepEqual(first, second);

  // 改返回值不影响下一次调用
  first[0].name = '被改过的名字';
  first[0].domains.push('evil.example.com');
  const third = listMedia({ search: '知乎' });
  assert.equal(third[0].name, '知乎');
  assert.ok(!third[0].domains.includes('evil.example.com'));
  assert.equal(byId('zhihu').name, '知乎');

  // 空对象兜底与 env 不参与筛选
  assert.equal(listMedia({}).length, MEDIA_CATALOG.length);
  assert.deepEqual(listMedia({ type: '问答社区', env: { PUBLISH_ZHIHU_WEBHOOK: 'x' } }), listMedia({ type: '问答社区' }));
});
