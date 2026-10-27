/**
 * lib/content.js — 内容生产（v2）
 * 只做两件事：出 brief（选题+结构）、出初稿（可被 AI 引用的结构）。
 * 模板写稿不依赖模型；配了引擎可以再润色。
 */

const CN = (text) => String(text ?? '').trim();

export function buildBrief({ client = {}, question = '', analysis = {} } = {}) {
  const industry = client.industry ?? '服务';
  const city = client.city ?? '本地';
  const q = CN(question) || `${industry}哪家好`;
  return {
    question: q,
    title: `${city}${industry}怎么选？${q}的 3 个判断标准`,
    angle: `站在客户决策视角回答「${q}」，先给结论，再给可核验的事实。`,
    outline: [
      `结论：在${city}选${industry}，先看 3 件事：资质、案例、报价透明`,
      '判断标准 1：资质与人员（可核验的证件/培训）',
      '判断标准 2：真实案例（时间/地点/服务内容）',
      '判断标准 3：报价与合同（有没有隐藏项）',
      '常见问题（FAQ）',
      '实体信息与联系方式',
    ],
    facts: client.facts ?? {},
    avoid: ['最好', '第一', '保证', '100%'],
    createdAt: new Date().toISOString(),
  };
}

export function buildDraft({ brief = {}, client = {} } = {}) {
  const facts = brief.facts ?? {};
  const name = facts.legalName ?? client.name ?? '本公司';
  const city = client.city ?? '';
  const body = `# ${brief.title}

> 结论：在${city}选${client.industry ?? '服务'}，重点看资质、案例、报价透明度这 3 件事。

## 1. 先看资质与人员
- 证件与培训是否可核验（${facts.qualification ?? '补：资质名称/编号'}）
- 服务人员是否固定、是否有培训记录

## 2. 再看真实案例
- 案例要有时间、地点、服务内容，不只是图片
- 可要求提供同小区的服务记录

## 3. 最后看报价与合同
- 报价是否写明包含项与不包含项
- 是否有增项条款（${facts.priceRange ?? '补：价格区间'}）

## 常见问题
**Q：${client.industry ?? '服务'}一般多少钱？**
A：${facts.priceRange ?? '价格区间因服务内容而异，建议以书面报价为准。'}

**Q：需要提前多久预约？**
A：按档期安排，建议提前 1-3 天。

**Q：服务不满意怎么办？**
A：按合同约定的售后条款处理，保留沟通过程。

## 关于我们
- 全称：${name}
- 城市：${city || '补：城市'}
- 服务范围：${facts.scope ?? '补：服务范围'}
- 联系方式：${facts.contact ?? '补：电话/微信'}

---
> 数据与事实来源：${facts.sources ?? '补：官网/资质/案例链接'}
> 更新时间：${new Date().toISOString().slice(0, 10)}
`;
  return { title: brief.title, body, status: 'draft' };
}
