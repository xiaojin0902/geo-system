// 测试：服务模式（自助/托管）与套餐解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, SERVICE_MODES, planOf, modeOf, resolveSubscription } from '../lib/plans.js';

const DAY = 86400000;
const future = new Date(Date.now() + 30 * DAY).toISOString();
const past = new Date(Date.now() - DAY).toISOString();

test('两种服务模式：自助可执行，托管只读', () => {
  assert.equal(SERVICE_MODES.self_service.clientCanAct, true);
  assert.equal(SERVICE_MODES.managed.clientCanAct, false);
  assert.equal(modeOf('managed').name, '托管版');
  assert.equal(modeOf('未知').id, 'self_service', '未知模式回落自助版');
});

test('三个套餐档位价格与配额递增', () => {
  assert.deepEqual(PLANS.map((p) => p.id), ['basic', 'pro', 'agency']);
  for (let i = 1; i < PLANS.length; i += 1) {
    assert.ok(PLANS[i].priceMonthly > PLANS[i - 1].priceMonthly);
    assert.ok(PLANS[i].quotaQuestions > PLANS[i - 1].quotaQuestions);
  }
  assert.equal(planOf('PRO').id, 'pro', '套餐 id 大小写不敏感');
  assert.equal(planOf('nope'), null);
});

test('未开通：active=false、配额 0、不能执行', () => {
  const sub = resolveSubscription({});
  assert.equal(sub.active, false);
  assert.equal(sub.planName, '未开通');
  assert.equal(sub.quotaQuestions, 0);
});

test('自助+有效订阅：客户可执行', () => {
  const sub = resolveSubscription({ plan: 'basic', service_mode: 'self_service', expire_at: future });
  assert.equal(sub.active, true);
  assert.equal(sub.clientCanAct, true);
  assert.equal(sub.quotaQuestions, PLANS[0].quotaQuestions);
});

test('托管+有效订阅：客户只读', () => {
  const sub = resolveSubscription({ plan: 'pro', service_mode: 'managed', expire_at: future });
  assert.equal(sub.active, true);
  assert.equal(sub.modeName, '托管版');
  assert.equal(sub.clientCanAct, false);
});

test('到期后：active=false 且不能执行（两种模式都一样）', () => {
  for (const mode of ['self_service', 'managed']) {
    const sub = resolveSubscription({ plan: 'pro', service_mode: mode, expire_at: past });
    assert.equal(sub.expired, true);
    assert.equal(sub.active, false);
    assert.equal(sub.clientCanAct, false, `${mode} 到期后不应可执行`);
  }
});

test('自定义配额覆盖套餐默认值', () => {
  const sub = resolveSubscription({ plan: 'basic', quota_questions: '999', expire_at: future });
  assert.equal(sub.quotaQuestions, 999);
  const zero = resolveSubscription({ plan: 'basic', quota_questions: '0', expire_at: future });
  assert.equal(zero.quotaQuestions, 0, '0 表示不限，应原样保留');
});

test('无到期日视为长期有效，但仍需已开通套餐', () => {
  const withPlan = resolveSubscription({ plan: 'basic' });
  assert.equal(withPlan.expired, false);
  assert.equal(withPlan.active, true);
  assert.equal(withPlan.expireAt, null);
  const noPlan = resolveSubscription({ service_mode: 'managed' });
  assert.equal(noPlan.active, false);
});
