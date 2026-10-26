#!/usr/bin/env node
// 线上入口：Render/Railway/Fly 等 PaaS 用 `node server.js` 启动。
// 与本地 `geo serve` 是同一套控制台（8 个页面、可立即执行）。
import { startServer } from './app/lib/server.js';

const port = Number(process.env.PORT) || 8787;
const auth =
  process.env.BASIC_USER && process.env.BASIC_PASS
    ? { user: process.env.BASIC_USER, pass: process.env.BASIC_PASS }
    : null;

const { url } = await startServer({
  port,
  host: '0.0.0.0',
  brand: process.env.GEO_BRAND || 'hengye',
  auth,
});
console.log(`恒野 GEO 控制台已启动：${url}${auth ? '（已开启 Basic Auth）' : '（未设密码，仅适合本地）'}`);
