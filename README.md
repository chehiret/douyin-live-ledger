# Douyin Live Ledger · 抖音主播数据管理器

管理多个主播和抖音账号，定时采集直播复盘数据，按日、月汇总直播时长与观众指标。适合个人主播、小型团队和运营人员自行部署。

这是通用源码发行版。安装后创建独立数据库，不附带任何现成账号、直播记录、登录凭据或业务数据。

## 功能

- 多主播、多账号管理，扫码登录、身份核对、绑定审核和登录状态检测。
- 管理员、主播、组长权限；主播查看自己的数据，组长查看自己和直属组员的数据。
- 定时同步、持久化任务队列、失败重试、历史补采、场次明细和 CSV 导出。
- 汇总直播时长、新增粉丝、送礼人数、加粉丝团人数、评论人数、曝光人数、进房人数和进房率。
- 月度直播保底、进度展示和站内提醒。
- 服务器 SQLite 存储，自动备份、校验、恢复和数据保留规则。
- 适配电脑和手机浏览器。

## 环境

- Node.js **22.12 或更新版本**，推荐 Node.js 24 LTS。
- Windows 使用已安装的 Microsoft Edge；Linux 使用 Playwright Chromium。
- 不需要 MySQL、Redis 或 PHP。服务器必须持续运行并联网才能执行后台任务。

## 安装与启动

下载仓库源码，进入项目目录后执行：

```bash
npm ci
npm run build
npm start
```

Linux 首次运行前需安装浏览器和系统依赖：

```bash
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium
```

Linux 运行时同样设置 `PLAYWRIGHT_BROWSERS_PATH=0`。可复制 `.env.example` 为 `.env` 并取消相应行的注释；`npm start` 会读取 `.env`。Windows PowerShell 可使用 `npm.cmd`。

默认访问地址为 `http://127.0.0.1:4173`。首次启动生成管理员 `admin`，随机初始密码保存在 `data/initial-admin.txt`。登录后修改密码，再添加主播并扫码绑定自己的抖音账号。

公网部署需配置域名、HTTPS、反向代理和 `LIVE_ORIGIN`，详细步骤见 [宝塔/Linux 部署](deploy/BAOTA.md)。Windows 的开机启动及备份恢复见 [部署维护说明](deploy/README.md)。

## 数据存储

账号、设置、权限和直播数据保存在服务器的 `data/live.sqlite`；抖音登录环境位于 `data/profiles/`。默认使用当前项目下的 `data`，也可以通过 `LIVE_DATA_DIR` 指定独立持久化目录。

升级时保留 `data`。不要把 `data`、`.env`、备份、浏览器登录环境或 Cookie 导出文件提交到 GitHub，仓库的 `.gitignore` 已排除这些文件。

自动清理仅保留当月和前两个月的直播明细，任务及运行记录保留最近 7 天，数据库备份保留最近 30 份。完整统计口径、权限、验证流程和保留规则见 [使用说明](docs/USAGE.md)。

## 开发与验证

```bash
npm test
npm run test:ui
npm run test:teams
npm run build
```

测试使用临时数据库和模拟页面；Linux 执行前需安装 Chromium，Windows 需要 Microsoft Edge。UI 测试输出到已忽略的 `test-output/`。前端为 React/Vite，后端为 Express/Node.js SQLite，网页采集使用 Playwright。

## 采集范围

采集在用户授权登录的抖音官方主播后台执行。短信、滑块、刷脸等身份验证需要账号本人完成。页面结构和平台策略变化可能使登录或采集失效；后台会记录错误，缺失指标不会当作零值写入。

## 许可证

采用 [MIT License](LICENSE)。可以使用、修改和分发，分发时保留许可证及版权声明。项目为独立工具，非抖音官方产品。
