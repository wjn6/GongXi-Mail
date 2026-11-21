# GongXi Mail 管理前端（web）

React 19 + Ant Design 6 + Vite 7 构建的管理面板，随 `server` 一起由 Fastify 在生产模式下静态托管。

## 开发

```bash
npm ci
npm run dev        # http://localhost:5173，/admin 与 /api 代理到 localhost:3000
```

后端需要先在 `server/` 启动（`npm run dev`），并配置好 PostgreSQL 与环境变量。

## 质量检查

```bash
npm run lint       # ESLint
npm run build      # tsc -b && vite build，产物在 dist/
```

## 结构

- `src/api/` — axios 封装：GET 去重、TTL 缓存、按前缀失效、统一错误提取
- `src/pages/` — 仪表盘、邮箱、API Key、API 文档、操作/系统日志、管理员、设置
- `src/stores/authStore.ts` — zustand 持久化的登录态
- `src/layouts/MainLayout.tsx` — 侧边栏与页头

路由守卫见 `src/App.tsx`：未登录跳 `/login`，管理员管理页仅 `SUPER_ADMIN` 可见。
