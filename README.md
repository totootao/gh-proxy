# gh-proxy

GitHub 反向代理,部署于 Cloudflare Workers。加速 `release` / `archive` / `raw` / `gist` / `api` 及 `git clone` 等请求,文件经 Cloudflare 边缘节点缓存中转。

## 功能

- **多类型代理**:release 下载、源码包、raw 文件、gist、REST API、`git clone`(Smart HTTP)
- **边缘缓存**:GET 请求(≤100MB)写入 Cloudflare 边缘缓存,热门文件命中后不再回源
- **白名单防护**:域名 + 路径双重校验,不会沦为任意转发代理;重定向逐跳校验,禁止 https 降级
- **流式转发**:大文件不落盘、不占内存
- **URL 自动纠错**:省略协议、`https:/` 单斜杠、`https://https://` 重复、`www.` 前缀、`blob` 文件页自动转 raw 直链
- **首页转换器**:粘贴 GitHub 链接实时生成加速地址,一键复制(转换规则由后端注入,与实际放行行为永远一致)
- **CORS 放行**:可直接用于浏览器端跨域请求

## 使用

在任意受支持的 GitHub 资源链接前拼接本站地址即可:

```bash
# release 下载
wget https://<域名>/https://github.com/user/repo/releases/download/v1.0/app.zip

# 源码包
curl -O https://<域名>/https://github.com/user/repo/archive/refs/heads/main.tar.gz

# raw 文件
curl -O https://<域名>/https://raw.githubusercontent.com/user/repo/main/README.md

# REST API
curl https://<域名>/https://api.github.com/repos/user/repo

# git clone
git clone https://<域名>/https://github.com/user/repo.git
```

协议可以省略,仓库文件页(`blob`)链接会自动转换为 raw 直链:

```bash
https://<域名>/github.com/user/repo/releases/download/v1.0/app.zip
https://<域名>/https://github.com/user/repo/blob/main/README.md
```

### 支持的上游

| 域名 | 允许的路径 |
| --- | --- |
| `github.com` | 全部路径(网页、release、archive、git 克隆;`blob` 文件页自动转 raw 直链) |
| `raw.githubusercontent.com` | 全部 |
| `gist.githubusercontent.com` | 全部 |
| `api.github.com` | 全部 |
| `codeload.github.com` | zip / tar.gz 源码包 |
| `objects.githubusercontent.com` 等 | release 资产重定向目标 |
| `avatars.githubusercontent.com`、`camo.githubusercontent.com` | 全部 |

缓存命中状态可通过响应头 `x-gh-proxy-cache` 查看(`HIT` / `MISS`)。

## 部署

1. 安装依赖:

   ```bash
   npm install
   ```

2. 登录 Cloudflare:

   ```bash
   npx wrangler login
   ```

3. 部署:

   ```bash
   npm run deploy
   ```

   部署完成后默认获得 `https://<name>.<account-subdomain>.workers.dev` 地址;也可在 Cloudflare 控制台为 Worker 绑定自定义域名。

### 配置

编辑 [wrangler.jsonc](wrangler.jsonc):

- `name`:Worker 名称
- `workers_dev`:是否启用 `workers.dev` 子域
- 自定义域名在 Cloudflare 控制台或用 `wrangler` 的 Workers Domains 绑定

白名单与路径规则在 [src/worker.js](src/worker.js) 的 `HOST_RULES` 中维护,按需增删域名或正则后重新部署即可。

## 本地开发

```bash
npm run dev   # 启动 http://127.0.0.1:8787
```

## 声明

本项目仅供个人学习与加速使用,请遵守 GitHub 服务条款与各仓库许可证,勿用于滥用场景。
