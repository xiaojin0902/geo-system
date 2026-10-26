// 测试：多语种 / 出海（locale 归一化、词条翻译、数字与百分比格式、提示词、判定、报告标题）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALES,
  resolveLocale,
  t,
  formatNumber,
  formatPercent,
  questionPromptTemplate,
  translateVerdict,
  localeReportTitle,
} from '../lib/i18n.js';

/** 判定十态（与 lib/judge.js 的 VERDICTS 同源） */
const VERDICTS = [
  'recommended',
  'conditionally_recommended',
  'candidate',
  'listed',
  'mentioned',
  'not_mentioned',
  'ambiguous',
  'unknown',
  'refused',
  'engine_error',
];

test('LOCALES：至少 4 个标准 locale，去重且含中英基准', () => {
  assert.ok(Array.isArray(LOCALES));
  assert.ok(LOCALES.length >= 4, '至少支持 4 个语种');
  assert.equal(new Set(LOCALES).size, LOCALES.length, 'locale 不应重复');
  for (const locale of LOCALES) {
    assert.match(locale, /^[a-z]{2}-[A-Z]{2}$/, `locale 形态不标准：${locale}`);
  }
  assert.ok(LOCALES.includes('zh-CN'), '必须有中文兜底');
  assert.ok(LOCALES.includes('en-US'), '必须有英文');
});

test('resolveLocale：语言码 / 大小写 / 下划线都归一化到标准 locale', () => {
  assert.equal(resolveLocale('zh'), 'zh-CN');
  assert.equal(resolveLocale('zh-cn'), 'zh-CN');
  assert.equal(resolveLocale('ZH-CN'), 'zh-CN');
  assert.equal(resolveLocale(' zh_CN '), 'zh-CN');
  assert.equal(resolveLocale('en'), 'en-US');
  assert.equal(resolveLocale('en-us'), 'en-US');
  assert.equal(resolveLocale('EN-US'), 'en-US');
  assert.equal(resolveLocale('ja'), 'ja-JP');
  assert.equal(resolveLocale('ja-JP'), 'ja-JP');
  assert.equal(resolveLocale('es'), 'es-ES');
  assert.equal(resolveLocale('es-419'), 'es-ES');
});

test('resolveLocale：未知语言与空输入一律回落 zh-CN', () => {
  assert.equal(resolveLocale('fr-FR'), 'zh-CN');
  assert.equal(resolveLocale('klingon'), 'zh-CN');
  assert.equal(resolveLocale(''), 'zh-CN');
  assert.equal(resolveLocale(null), 'zh-CN');
  assert.equal(resolveLocale(undefined), 'zh-CN');
  assert.equal(resolveLocale(123), 'zh-CN');
});

test('t：同一 key 在四种语言下取到各自文案', () => {
  assert.equal(t('score', 'zh-CN'), '总分');
  assert.equal(t('score', 'en-US'), 'Score');
  assert.equal(t('score', 'ja-JP'), 'スコア');
  assert.equal(t('score', 'es-ES'), 'Puntuación');
  // 简写 locale 也能命中
  assert.equal(t('report', 'zh'), '报告');
  assert.equal(t('report', 'en'), 'Report');
});

test('t：{name} 占位符按 vars 替换，多余变量被忽略', () => {
  assert.equal(
    t('reportSubtitle', 'zh-CN', { brand: '恒野', period: '2026-10' }),
    '品牌：恒野 · 周期：2026-10',
  );
  assert.equal(
    t('reportSubtitle', 'en-US', { brand: 'Henye', period: '2026-10' }),
    'Brand: Henye · Period: 2026-10',
  );
  assert.equal(t('sampleCount', 'zh-CN', { count: 42 }), '样本 42 条');
  assert.equal(t('sampleCount', 'zh-CN', { count: 7, extra: '忽略我' }), '样本 7 条');
});

test('t：变量缺失时保留占位符原样，不渲染成 undefined', () => {
  assert.equal(t('sampleCount', 'zh-CN', {}), '样本 {count} 条');
  assert.equal(t('sampleCount', 'zh-CN'), '样本 {count} 条');
  assert.equal(t('reportSubtitle', 'en-US', { brand: 'Henye' }), 'Brand: Henye · Period: {period}');
});

test('t：目标语言缺词条时回落 zh-CN（海外不用的中文指标）', () => {
  assert.equal(t('baiduIndex', 'zh-CN'), '百度指数');
  assert.equal(t('baiduIndex', 'en-US'), '百度指数', '英文缺这条 → 回落中文');
  assert.equal(t('baiduIndex', 'ja-JP'), '百度指数');
  assert.equal(t('baiduIndex', 'es-ES'), '百度指数');
});

test('t：zh-CN 也缺失时返回 locale:key，不返回空串（漏词条可发现）', () => {
  assert.equal(t('not_a_real_key', 'en-US'), 'en-US:not_a_real_key');
  assert.equal(t('not_a_real_key', 'zh-CN'), 'zh-CN:not_a_real_key');
  const missing = t('nope', 'es-ES');
  assert.notEqual(missing, '', '缺词条不能静默返回空串');
  assert.ok(missing.includes('nope'), '返回值里要能看到漏掉的 key');
  assert.ok(missing.includes('es-ES'), '返回值里要能看到语言，便于定位');
});

test('t：空 key / 缺省 locale 不抛错', () => {
  assert.equal(typeof t(''), 'string');
  assert.equal(typeof t('', 'en-US'), 'string');
  assert.equal(typeof t('score'), 'string');
  assert.equal(t('score', undefined), '总分', '缺省 locale 走 zh-CN');
});

test('词条覆盖：指标/判定/章节/页面/通用共 53 条，四种语言全齐', () => {
  // baiduIndex 是故意只存在中文的词条（上面用它验证回落），不列入齐全性检查
  const REQUIRED = [
    // 指标
    'score', 'mentionRate', 'citations', 'ownShare', 'shareOfVoice', 'sentiment', 'sample',
    // 判定十态
    ...VERDICTS,
    // 报告章节
    'summary', 'highlights', 'risks', 'actions', 'nextWeek', 'engines', 'dataQuality',
    // 页面 / CLI
    'diagnose', 'insights', 'weekly', 'cockpit', 'report', 'plan',
    // 通用
    'yes', 'no', 'none', 'generatedAt', 'brand',
    // 报告常用补充
    'citationCount', 'citationSources', 'coverage', 'rank', 'trend', 'verdictDistribution',
    'evidence', 'noData', 'total', 'average', 'period', 'language', 'up', 'down', 'flat',
    'reportTitle', 'sampleCount', 'reportSubtitle',
  ];
  assert.ok(REQUIRED.length >= 40, `词条至少 40 条，当前 ${REQUIRED.length}`);
  assert.equal(new Set(REQUIRED).size, REQUIRED.length, '检查清单本身不应重复');
  for (const locale of LOCALES) {
    for (const key of REQUIRED) {
      const label = t(key, locale);
      assert.notEqual(label, `${locale}:${key}`, `${locale} 缺少词条：${key}`);
      assert.ok(label.trim().length > 0, `${locale} 的词条 ${key} 是空白`);
    }
  }
});

test('formatNumber：en-US / zh-CN / ja-JP 用逗号千分位、点小数点', () => {
  for (const locale of ['en-US', 'zh-CN', 'ja-JP']) {
    assert.equal(formatNumber(1234.5, locale), '1,234.5');
    assert.equal(formatNumber(1234567, locale), '1,234,567');
    assert.equal(formatNumber(0, locale), '0');
    assert.equal(formatNumber(999, locale), '999');
  }
});

test('formatNumber：es-ES 用点千分位、逗号小数点', () => {
  assert.equal(formatNumber(1234.5, 'es-ES'), '1.234,5');
  assert.equal(formatNumber(1234567, 'es-ES'), '1.234.567');
  assert.equal(formatNumber(1000, 'es-ES'), '1.000');
  assert.equal(formatNumber(0.5, 'es-ES'), '0,5');
});

test('formatNumber：负数保号、末尾 0 裁掉、超 3 位小数四舍五入', () => {
  assert.equal(formatNumber(-1234.5, 'en-US'), '-1,234.5');
  assert.equal(formatNumber(-1234.5, 'es-ES'), '-1.234,5');
  assert.equal(formatNumber(1234.5, 'zh-CN'), '1,234.5', '1,234.500 不应留下尾随 0');
  assert.equal(formatNumber(12.3456, 'zh-CN'), '12.346');
  assert.equal(formatNumber('1234.5', 'en-US'), '1,234.5', '数字字符串也应可用');
});

test('formatNumber：非法数字返回占位符 —，不伪造 0', () => {
  for (const bad of [null, undefined, '', '   ', 'abc', NaN, Infinity, -Infinity, true]) {
    assert.equal(formatNumber(bad, 'zh-CN'), '—');
  }
});

test('formatPercent：中文 / 英文 / 日文都是「25.0%」', () => {
  assert.equal(formatPercent(0.25, 'zh-CN'), '25.0%');
  assert.equal(formatPercent(0.25, 'en-US'), '25.0%');
  assert.equal(formatPercent(0.25, 'ja-JP'), '25.0%');
  assert.equal(formatPercent(1, 'zh-CN'), '100.0%');
  assert.equal(formatPercent(0, 'zh-CN'), '0.0%');
});

test('formatPercent：西语「25,0 %」——逗号小数点 + 空格', () => {
  assert.equal(formatPercent(0.25, 'es-ES'), '25,0 %');
  assert.equal(formatPercent(1, 'es-ES'), '100,0 %');
  assert.equal(formatPercent(0.2567, 'es-ES'), '25,7 %');
});

test('formatPercent：digits 参数控制小数位，比率超 10 倍时仍带千分位', () => {
  assert.equal(formatPercent(0.25, 'zh-CN', 0), '25%');
  assert.equal(formatPercent(0.2567, 'en-US', 2), '25.67%');
  assert.equal(formatPercent(0.2567, 'es-ES', 2), '25,67 %');
  assert.equal(formatPercent(12.3456, 'en-US', 1), '1,234.6%', '1234.56% 的整数部分要分组');
  assert.equal(formatPercent('abc', 'zh-CN'), '—');
  assert.equal(formatPercent(null, 'es-ES'), '—');
});

test('questionPromptTemplate：中文模板覆盖价格/对比/推荐/流程/风险五类意图', () => {
  const text = questionPromptTemplate('zh-CN');
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 100, '提示词应有实质内容');
  for (const keyword of ['价格', '对比', '推荐', '流程', '风险']) {
    assert.ok(text.includes(keyword), `中文模板缺少意图关键词：${keyword}`);
  }
  assert.ok(text.includes('品牌名'), '必须要求不出现品牌名');
  assert.ok(text.includes('10'), '应约定问题数量');
});

test('questionPromptTemplate：英文模板覆盖 price/comparison/recommendation/process/risk', () => {
  const text = questionPromptTemplate('en-US');
  for (const keyword of ['price', 'comparison', 'recommendation', 'process', 'risk']) {
    assert.ok(text.toLowerCase().includes(keyword), `英文模板缺少意图关键词：${keyword}`);
  }
  assert.ok(text.includes('brand name'), '必须要求不出现品牌名');
  assert.notEqual(text, questionPromptTemplate('zh-CN'), '英文模板不能复用中文');
});

test('questionPromptTemplate：日文模板覆盖 価格/比較/おすすめ/手順/リスク', () => {
  const text = questionPromptTemplate('ja-JP');
  for (const keyword of ['価格', '比較', 'おすすめ', '手順', 'リスク']) {
    assert.ok(text.includes(keyword), `日文模板缺少意图关键词：${keyword}`);
  }
  assert.ok(text.includes('ブランド名'), '必须要求不出现品牌名');
});

test('questionPromptTemplate：西语模板覆盖 precio/comparación/recomendación/proceso/riesgo', () => {
  const text = questionPromptTemplate('es-ES');
  for (const keyword of ['precio', 'comparación', 'recomendación', 'proceso', 'riesgo']) {
    assert.ok(text.includes(keyword), `西语模板缺少意图关键词：${keyword}`);
  }
  assert.ok(text.includes('marca'), '必须要求不出现品牌名');
});

test('questionPromptTemplate：简写与未知 locale 分别落到英文 / 中文模板', () => {
  assert.equal(questionPromptTemplate('en'), questionPromptTemplate('en-US'));
  assert.equal(questionPromptTemplate('JA'), questionPromptTemplate('ja-JP'));
  assert.equal(questionPromptTemplate('fr-FR'), questionPromptTemplate('zh-CN'));
  assert.equal(questionPromptTemplate(undefined), questionPromptTemplate('zh-CN'));
});

test('translateVerdict：十态中英对照全覆盖，且每条都非空', () => {
  const zh = {
    recommended: '推荐',
    conditionally_recommended: '条件推荐',
    candidate: '候选',
    listed: '列入',
    mentioned: '仅提及',
    not_mentioned: '未提及',
    ambiguous: '歧义',
    unknown: '未知',
    refused: '拒答',
    engine_error: '引擎错误',
  };
  const en = {
    recommended: 'Recommended',
    conditionally_recommended: 'Conditionally recommended',
    candidate: 'Candidate',
    listed: 'Listed',
    mentioned: 'Mentioned only',
    not_mentioned: 'Not mentioned',
    ambiguous: 'Ambiguous',
    unknown: 'Unknown',
    refused: 'Refused',
    engine_error: 'Engine error',
  };
  assert.equal(Object.keys(zh).length, 10, '十态必须齐全');
  for (const verdict of VERDICTS) {
    assert.equal(translateVerdict(verdict, 'zh-CN'), zh[verdict]);
    assert.equal(translateVerdict(verdict, 'en-US'), en[verdict]);
  }
});

test('translateVerdict：四种语言都翻得出来，且英文十态互不重复', () => {
  for (const locale of LOCALES) {
    const labels = VERDICTS.map((verdict) => translateVerdict(verdict, locale));
    for (const label of labels) {
      assert.equal(typeof label, 'string');
      assert.ok(label.trim().length > 0, `${locale} 有判定没翻译`);
    }
    assert.equal(new Set(labels).size, 10, `${locale} 的十态译文应互不重复`);
  }
});

test('translateVerdict：未知判定原样返回，空输入返回空串', () => {
  assert.equal(translateVerdict('something_new', 'en-US'), 'something_new');
  assert.equal(translateVerdict('something_new', 'zh-CN'), 'something_new');
  assert.equal(translateVerdict('partial', 'ja-JP'), 'partial');
  assert.equal(translateVerdict('', 'zh-CN'), '');
  assert.equal(translateVerdict(null, 'zh-CN'), '');
});

test('localeReportTitle：中英日三语标题与括号形态正确', () => {
  assert.equal(
    localeReportTitle({ brand: '恒野', locale: 'zh-CN', period: '2026-10' }),
    '恒野 · GEO 诊断报告（2026-10）',
  );
  assert.equal(
    localeReportTitle({ brand: '恒野', locale: 'en-US', period: '2026-10' }),
    'Henye · GEO Diagnostic Report (2026-10)',
    '英文标题用登记过的英文品牌名与半角括号',
  );
  assert.equal(
    localeReportTitle({ brand: '恒野', locale: 'ja-JP', period: '2026-10' }),
    '恒野 · GEO 診断レポート（2026-10）',
  );
  assert.equal(
    localeReportTitle({ brand: '恒野', locale: 'es-ES', period: '2026-10' }),
    '恒野 · Informe de diagnóstico GEO (2026-10)',
  );
});

test('localeReportTitle：周期或品牌为空时不留空括号与多余分隔符', () => {
  assert.equal(localeReportTitle({ brand: '恒野', locale: 'zh-CN' }), '恒野 · GEO 诊断报告');
  assert.equal(
    localeReportTitle({ brand: '', locale: 'zh-CN', period: '2026-10' }),
    'GEO 诊断报告（2026-10）',
  );
  assert.equal(localeReportTitle({ brand: '', locale: 'en-US', period: '' }), 'GEO Diagnostic Report');
  assert.equal(
    localeReportTitle({ brand: ' 恒野 ', locale: 'zh-CN', period: ' 2026-10 ' }),
    '恒野 · GEO 诊断报告（2026-10）',
    '首尾空格要去掉',
  );
});

test('localeReportTitle：默认参数与未知 locale 不崩', () => {
  assert.equal(localeReportTitle(), 'GEO 诊断报告');
  assert.equal(typeof localeReportTitle({}), 'string');
  assert.equal(
    localeReportTitle({ brand: 'Henye', locale: 'fr-FR', period: '2026-10' }),
    'Henye · GEO 诊断报告（2026-10）',
    '未知 locale 走中文标题',
  );
});

test('确定性：相同入参重复调用，输出完全一致', () => {
  const args = { brand: '恒野', locale: 'en-US', period: '2026-10' };
  const snapshot = () => [
    t('reportSubtitle', 'ja-JP', { brand: '恒野', period: '2026-10' }),
    formatNumber(1234.5, 'es-ES'),
    formatNumber(-0.5, 'en-US'),
    formatPercent(0.2567, 'es-ES'),
    formatPercent(0.2567, 'zh-CN', 2),
    questionPromptTemplate('es-ES'),
    translateVerdict('conditionally_recommended', 'ja-JP'),
    localeReportTitle(args),
  ];
  const first = snapshot();
  for (let round = 0; round < 3; round += 1) {
    assert.deepEqual(snapshot(), first, `第 ${round + 1} 次调用结果发生了变化`);
  }
});
