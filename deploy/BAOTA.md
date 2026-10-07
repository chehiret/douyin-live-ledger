# Linux / 宝塔部署

以下使用 `/www/wwwroot/douyin-live-ledger` 和 `https://live.example.com` 作为示例，请替换为自己的目录和域名。本源码不含现成数据库或登录环境，首次启动会创建新数据库。

## 安装

安装 Node.js 22.12+（推荐 24 LTS）和 Nginx，上传源码并解压。

```bash
cd /www/wwwroot/douyin-live-ledger
node -v
npm ci
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium
npm run build
cp .env.example .env
```

安装浏览器的系统依赖需要管理员权限。不要复制 Windows 的 `node_modules`，Linux 上重新安装。

编辑 `.env`：

```dotenv
NODE_ENV=production
PORT=4173
LIVE_HOST=127.0.0.1
LIVE_ORIGIN=https://live.example.com
LIVE_TRUST_PROXY=1
PLAYWRIGHT_BROWSERS_PATH=0
```

`LIVE_ORIGIN` 必须和浏览器访问地址完全一致，包括协议和非默认端口，不带结尾斜杠。数据默认保存于项目的 `data`，需要独立持久化目录时设置 `LIVE_DATA_DIR`。

## 进程管理

宝塔 Node 项目使用项目根目录、启动命令 `npm start`、监听端口 4173。以 `www` 等专用用户运行，启用守护和开机启动，只运行一个实例，不使用 cluster。

也可使用 [live-ledger.service.example](live-ledger.service.example) 安装 systemd 服务。按实际项目目录、运行用户和 `command -v node` 的结果修改模板后执行：

```bash
cp deploy/live-ledger.service.example /etc/systemd/system/live-ledger.service
systemctl daemon-reload
systemctl enable --now live-ledger.service
systemctl status live-ledger.service
```

宝塔守护和 systemd 选择一种，避免重复启动。修改源码或配置后，通过选定的进程管理器重启。

运行用户需要能读写数据目录。以 `www` 和默认数据目录为例：

```bash
mkdir -p data
chown -R www:www /www/wwwroot/douyin-live-ledger
chmod 700 data
chmod 600 .env
```

首次启动管理员密码位于 `data/initial-admin.txt`；登录后修改密码。升级保留整个 `data`，不要用空目录覆盖。

## Nginx

在宝塔为域名申请证书，将所有请求反向代理至 `http://127.0.0.1:4173`。保留带端口的 Host。将下面片段合并到 HTTPS 站点的 `server` 内：

```nginx
location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
    proxy_buffering off;
}
```

不要将项目根目录作为可直接下载文件的静态目录；反向代理只公开应用页面。4173 保持仅本机监听，防火墙放行对外的 HTTPS 端口。

## 验证与维护

访问 `/api/health` 应返回 `live-ledger`。确认首页、登录、扫码和权限正常，再启用定时采集。首次安装需要重新添加并绑定自己的账号。

网站的数据备份功能会创建一致的 SQLite 快照。恢复时同时保留 `.sqlite` 和校验清单，具体操作见 [部署维护说明](README.md)。浏览器登录环境需停采后单独备份。
