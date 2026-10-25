// 测试：bin/geo.js 命令行冒烟（--help / init / runs / brief+write / 百分比格式 / 错误路径）。
//
// 说明：diagnose / keywords / brief / publish / monitor 的完整链路依赖其它成员负责的
// lib/engines/*、judge.js、score.js、keywords.js、brief.js、report.js；这些模块各自有单测，
// Lead 也会在模块齐备后跑集成验收。本文件只覆盖「不依赖它们」的命令与错误路径，
// 避免并行开发阶段互相阻塞；write 冒烟走模板模式（不联网、不读 key），只依赖 lib/writer.js + lib/brief.js。
//
// 所有命令都通过 HENGYE_GEO_DATA_DIR 指向 mkdtemp 临时目录，绝不触碰 app/data/geo.db。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { formatPercent } from '../bin/geo.js';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/geo.js', import.meta.url));

function runCli(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: APP_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengye-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function queryDb(file, sql, ...params) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

test('--help 打印全部命令的中文说明', () => {
  const { code, stdout, stderr } = runCli(['--help']);
  assert.equal(code, 0, stderr);
  for (const command of ['init', 'diagnose', 'keywords', 'brief', 'write', 'publish', 'monitor', 'report', 'runs']) {
    assert.ok(stdout.includes(command), `帮助里缺少命令 ${command}`);
  }
  assert.match(stdout, /用法/);
  assert.match(stdout, /DEMO 演示数据/);
  assert.match(stdout, /--engines mock/);
  assert.match(stdout, /--engines deepseek\|dashscope\|none/);
  assert.match(stdout, /data\/drafts/);
  assert.equal(stderr.includes('✖'), false, '帮助不应报错');
});

test('init 建库、写品牌、seed 99 条题目，且重复执行幂等', (t) => {
  const dir = tempDataDir(t);
  const env = { HENGYE_GEO_DATA_DIR: dir };
  const first = runCli(['init', '--brand', 'hengye'], { env });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /初始化完成/);
  assert.match(first.stdout, /本次新增 99 条/);

  const dbFile = path.join(dir, 'geo.db');
  assert.ok(fs.existsSync(dbFile), '应生成 data 目录下的 geo.db');
  const brands = queryDb(dbFile, 'SELECT slug, name, legal_name, aliases_json, ambiguous_aliases_json FROM brands');
  assert.equal(brands.length, 1);
  assert.equal(brands[0].slug, 'hengye');
  assert.equal(brands[0].name, '恒野');
  assert.equal(brands[0].legal_name, '芜湖恒野数字科技有限公司');
  assert.ok(String(brands[0].aliases_json).includes('恒野'));
  assert.ok(String(brands[0].ambiguous_aliases_json).includes('恒野'), '别名歧义字段必须落库，供 judge 使用');
  assert.equal(Number(queryDb(dbFile, 'SELECT COUNT(*) AS n FROM questions')[0].n), 99);

  const second = runCli(['init', '--brand', 'hengye'], { env });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /本次新增 0 条/);
  assert.equal(Number(queryDb(dbFile, 'SELECT COUNT(*) AS n FROM questions')[0].n), 99, '重复 init 不应重复 seed');
});

test('init --json 输出纯净可解析的 JSON', (t) => {
  const dir = tempDataDir(t);
  const { code, stdout } = runCli(['init', '--brand', 'hengye', '--json'], { env: { HENGYE_GEO_DATA_DIR: dir } });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.brandId, 1);
  assert.equal(payload.slug, 'hengye');
  assert.equal(payload.questionInserted, 99);
  assert.equal(payload.questionTotal, 99);
  assert.equal(payload.dbPath, path.join(dir, 'geo.db'));
});

test('init 找不到品牌配置时退出码 1 并给出中文提示', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengye-cli-'));
  try {
    const { code, stderr } = runCli(['init', '--brand', 'nope'], { env: { HENGYE_GEO_DATA_DIR: dir } });
    assert.equal(code, 1);
    assert.match(stderr, /找不到品牌配置/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init --brand 非法时退出码 1', () => {
  const { code, stderr } = runCli(['init', '--brand', '../etc']);
  assert.equal(code, 1);
  assert.match(stderr, /不合法/);
});

test('runs 初始化后无跑步记录时给出下一步提示', (t) => {
  const dir = tempDataDir(t);
  const env = { HENGYE_GEO_DATA_DIR: dir };
  assert.equal(runCli(['init', '--brand', 'hengye'], { env }).code, 0);
  const { code, stdout } = runCli(['runs', '--brand', 'hengye'], { env });
  assert.equal(code, 0);
  assert.match(stdout, /暂无运行记录/);
  assert.match(stdout, /diagnose --brand hengye --engines mock/);
});

test('runs --json 在无记录时返回空数组', (t) => {
  const dir = tempDataDir(t);
  const env = { HENGYE_GEO_DATA_DIR: dir };
  assert.equal(runCli(['init', '--brand', 'hengye'], { env }).code, 0);
  const { code, stdout } = runCli(['runs', '--brand', 'hengye', '--json'], { env });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.brand, 'hengye');
  assert.deepEqual(payload.runs, []);
});

test('未初始化的品牌执行 runs 时退出码 1 并提示先 init', (t) => {
  const dir = tempDataDir(t);
  const env = { HENGYE_GEO_DATA_DIR: dir };
  const { code, stderr } = runCli(['runs', '--brand', 'hengye'], { env });
  assert.equal(code, 1);
  assert.match(stderr, /数据库中没有品牌/);
  assert.match(stderr, /init --brand hengye/);
});

test('report 不存在的 run 时退出码 1（先校验 run，再加载报告模块）', (t) => {
  const dir = tempDataDir(t);
  const env = { HENGYE_GEO_DATA_DIR: dir };
  assert.equal(runCli(['init', '--brand', 'hengye'], { env }).code, 0);
  const { code, stderr } = runCli(['report', '--run', '999'], { env });
  assert.equal(code, 1);
  assert.match(stderr, /run #999 不存在/);
});

test('brief 缺少 --keyword 时退出码 1（参数校验先于模块加载）', () => {
  const { code, stderr } = runCli(['brief', '--brand', 'hengye']);
  assert.equal(code, 1);
  assert.match(stderr, /缺少 --keyword/);
});

test('publish 缺少 --channel 时退出码 1', () => {
  const { code, stderr } = runCli(['publish', '--brand', 'hengye', '--content', '1']);
  assert.equal(code, 1);
  assert.match(stderr, /缺少 --channel/);
});

test('未知命令退出码 1 并列出可用命令', () => {
  const { code, stderr } = runCli(['frobnicate']);
  assert.equal(code, 1);
  assert.match(stderr, /未知命令：frobnicate/);
  assert.match(stderr, /init \/ diagnose/);
});

test('非法数字参数退出码 1', () => {
  const { code, stderr } = runCli(['runs', '--limit', 'abc']);
  assert.equal(code, 1);
  assert.match(stderr, /--limit 需要正整数/);
});

// ------------------------------------------------------------- write 命令冒烟

/** 准备临时环境并生成一条带 brief 的 content（init → brief --question 1）。 */
function prepareContent(t) {
  const dir = tempDataDir(t);
  const env = { HENGYE_GEO_DATA_DIR: dir };
  assert.equal(runCli(['init', '--brand', 'hengye'], { env }).code, 0);
  const brief = runCli(['brief', '--brand', 'hengye', '--question', '1', '--json'], { env });
  assert.equal(brief.code, 0, brief.stderr);
  const payload = JSON.parse(brief.stdout);
  assert.ok(Number.isInteger(payload.contentId), 'brief --json 应返回 contentId');
  return { dir, env, contentId: payload.contentId };
}

test('write 模板模式：0 违规 → draft，body_md 落库并写 data/drafts/<id>.md', (t) => {
  const { dir, env, contentId } = prepareContent(t);
  const result = runCli(
    ['write', '--brand', 'hengye', '--content', String(contentId), '--engines', 'none', '--json'],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.contentId, contentId);
  assert.equal(payload.mode, 'template');
  assert.equal(payload.engineId, null);
  assert.equal(payload.status, 'draft');
  assert.equal(payload.violationCount, 0);
  assert.equal(payload.passed, true);
  assert.ok(payload.wordCount > 0, '应返回字数');
  assert.deepEqual(payload.violationTypes, []);

  const draftFile = path.join(dir, 'drafts', `${contentId}.md`);
  assert.equal(payload.draftFile, draftFile);
  assert.ok(fs.existsSync(draftFile), '草稿文件应存在');
  const markdown = fs.readFileSync(draftFile, 'utf8');
  assert.ok(markdown.includes('# '), '草稿应是 Markdown');
  assert.ok(markdown.includes('事实与来源'), '模板模式应包含「事实与来源」小节');

  const row = queryDb(path.join(dir, 'geo.db'), 'SELECT status, body_md FROM contents WHERE id = ?', contentId)[0];
  assert.equal(row.status, 'draft');
  assert.ok(String(row.body_md).length > 0, 'body_md 应已落库');
});

test('write 人类可读输出含模式 / 字数 / 状态 / 草稿路径', (t) => {
  const { env, contentId } = prepareContent(t);
  const result = runCli(['write', '--brand', 'hengye', '--content', String(contentId), '--engines', 'none'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /草稿已生成：content #\d+/);
  assert.match(result.stdout, /模式：template/);
  assert.match(result.stdout, /字数：\d+/);
  assert.match(result.stdout, /状态 draft/);
  assert.match(result.stdout, /草稿：.*\.md/);
});

test('write 可重复执行，覆盖同一 content 的草稿文件', (t) => {
  const { env, contentId } = prepareContent(t);
  assert.equal(
    runCli(['write', '--brand', 'hengye', '--content', String(contentId), '--engines', 'none'], { env }).code,
    0,
  );
  const second = runCli(
    ['write', '--brand', 'hengye', '--content', String(contentId), '--engines', 'none', '--json'],
    { env },
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).contentId, contentId);
});

test('write 参数校验与错误路径', (t) => {
  const { env, contentId } = prepareContent(t);

  const missingContent = runCli(['write', '--brand', 'hengye'], { env });
  assert.equal(missingContent.code, 1);
  assert.match(missingContent.stderr, /缺少 --content/);

  const badEngine = runCli(
    ['write', '--brand', 'hengye', '--content', String(contentId), '--engines', 'gpt'],
    { env },
  );
  assert.equal(badEngine.code, 1);
  assert.match(badEngine.stderr, /--engines 只支持/);

  const notFound = runCli(['write', '--brand', 'hengye', '--content', '9999', '--engines', 'none'], { env });
  assert.equal(notFound.code, 1);
  assert.match(notFound.stderr, /content #9999 不存在/);
});

test('formatPercent 保留 1 位小数，与报告口径一致', () => {
  assert.equal(formatPercent(2 / 3), '66.7%');
  assert.equal(formatPercent(1), '100.0%');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(0.5), '50.0%');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(undefined), '—');
  assert.equal(formatPercent(2 / 3) === '67%', false, '不能再用整数四舍五入');
});

test('monitor 后自动刷新 data/reports/index.html（新增 run 立即可见）', (t) => {
  const dir = tempDataDir(t);
  const env = { HENGYE_GEO_DATA_DIR: dir };
  assert.equal(runCli(['init', '--brand', 'hengye'], { env }).code, 0);

  const first = runCli(['monitor', '--brand', 'hengye', '--engines', 'mock', '--limit', '2'], { env });
  assert.equal(first.code, 0, first.stderr);
  const indexFile = path.join(dir, 'reports', 'index.html');
  assert.ok(fs.existsSync(indexFile), 'monitor 应生成 index.html');
  const firstHtml = fs.readFileSync(indexFile, 'utf8');
  assert.ok(firstHtml.includes('run-1'), 'index.html 应包含本次 monitor 的 run-1');
  assert.ok(firstHtml.includes('run-1.html'), 'index.html 应链接到 run-1 报告');

  const second = runCli(['monitor', '--brand', 'hengye', '--engines', 'mock', '--limit', '2', '--json'], { env });
  assert.equal(second.code, 0, second.stderr);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.runId, 2);
  assert.equal(payload.indexHtml, indexFile);
  assert.ok(fs.readFileSync(indexFile, 'utf8').includes('run-2'), '第二次 monitor 后 index.html 应包含 run-2');
});
