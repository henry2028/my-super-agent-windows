import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
// scripts/dsh-superagent 是 POSIX 专用实现（fcntl / ps / tmux），Windows 上不可执行；Windows 的服务管理器是
// bin/superagent.mjs，它的用例尚未补。这里按平台排除，避免把"平台不适用"报成"测试失败"。
const posixOnly = process.platform === 'win32' ? ['tests/service-script.spec.ts'] : []
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['node_modules/**', ...posixOnly] } })
