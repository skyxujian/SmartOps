# SmartOps 运维工单系统

公开报修入口与管理员工作台，使用 Express、Better Auth 和 Neon PostgreSQL。支持工单提交、搜索、详情、状态更新和管理员新增/删除。

- 首页 `/`，报修 `/report.html`，后台 `/admin.html`。
- 密码由 Better Auth 进行加盐 scrypt 哈希，使用 HttpOnly Cookie 会话；所有管理接口验证服务端权限。
- 禁止公开注册，新增账号首次登录必须修改临时密码。删除账号撤销会话，并保护当前账号和最后一位管理员。
- 原 Worker 未修改，历史工单尚未迁移。原报修页面备份在 `/legacy-repair.html`，原雷达页面在 `/legacy-radar.html`。

## 本地运行

需要 Node.js 24 和真实 PostgreSQL 连接。

```sh
npm ci
cp .env.example .env.local
# 在 .env.local 配置 DATABASE_URL_UNPOOLED、随机 BETTER_AUTH_SECRET 和 APP_ORIGIN
npm run db:migrate
INITIAL_ADMIN_FILE=/private/tmp/smartops-access.txt npm run admin:create
npm start
```

数据库默认使用 `smartops` 命名空间；预览使用 `smartops_preview`。`npm test` 在真实数据库的独立临时空间运行并清理测试数据，不清理业务表。

`.env.local`、`.vercel`、初始登录文件和数据库备份不得上传。Vercel 项目为 `yangmao-radar`；生产环境 `APP_ORIGIN=https://www.xudev.xyz`，数据库连接和会话密钥应为 Secret 类型。

详细操作与历史数据限制见 [使用文档](docs/使用文档.md)。
