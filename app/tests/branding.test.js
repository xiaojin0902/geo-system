// 测试：系统品牌名变量化（一处改名全站生效）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SYSTEM_NAME, systemName, systemEdition, systemTagline } from '../lib/branding.js';

test('未设变量时用默认品牌名', () => {
  assert.equal(systemName({}), DEFAULT_SYSTEM_NAME);
  assert.equal(systemName({ GEO_SYSTEM_NAME: '' }), DEFAULT_SYSTEM_NAME);
  assert.equal(systemName({ GEO_SYSTEM_NAME: '   ' }), DEFAULT_SYSTEM_NAME);
});

test('变量可覆盖品牌名，并能去掉首尾空格', () => {
  assert.equal(systemName({ GEO_SYSTEM_NAME: '恒见 GEO' }), '恒见 GEO');
  assert.equal(systemName({ GEO_SYSTEM_NAME: '  恒见 GEO  ' }), '恒见 GEO');
});

test('版本名 = 系统名 + 自研版', () => {
  assert.equal(systemEdition({ GEO_SYSTEM_NAME: '恒见 GEO' }), '恒见 GEO 自研版');
  assert.equal(systemEdition({}), `${DEFAULT_SYSTEM_NAME} 自研版`);
});

test('标语变量为空时返回空串（不伪造）', () => {
  assert.equal(systemTagline({}), '');
  assert.equal(systemTagline({ GEO_SYSTEM_TAGLINE: '让 AI 看见你' }), '让 AI 看见你');
});
