/**
 * gh-proxy on Cloudflare Workers
 * GitHub 反向代理:加速 release / archive / raw / gist / git clone 等请求
 * 思路参考 https://github.com/hunshcn/gh-proxy (Apache-2.0)
 *
 * 用法:在任意 GitHub 资源链接前拼接本服务地址,例如
 *   https://<你的域名>/https://github.com/user/repo/releases/download/v1.0/app.zip
 *   https://<你的域名>/https://raw.githubusercontent.com/user/repo/main/README.md
 *   git clone https://<你的域名>/https://github.com/user/repo.git
 */

const MAX_REDIRECTS = 5
const MAX_CACHE_BYTES = 100 * 1024 * 1024 // 写入边缘缓存的最大体积

// 上游域名白名单及允许的路径(防止被当作任意转发代理滥用)
const HOST_RULES = {
  'github.com': [
    /^\/[^/]+\/[^/]+(?:\.git)?\/(?:releases|archive)\//,          // release 资产与源码包
    /^\/[^/]+\/[^/]+(?:\.git)?\/(?:info\/refs|git-upload-pack)$/, // git clone(Smart HTTP)
  ],
  'raw.githubusercontent.com': [/^\/.*/],
  'gist.githubusercontent.com': [/^\/.*/],
  'api.github.com': [/^\/.*/],
  'codeload.github.com': [/^\/[^/]+\/[^/]+\/(?:legacy\.)?(?:zip|tar|tar\.gz)\//],
  // 以下为 release 资产重定向目标 / 图片域名
  'objects.githubusercontent.com': [/^\/.*/],
  'release-assets.githubusercontent.com': [/^\/.*/],
  'github-releases.githubusercontent.com': [/^\/.*/],
  'copia.githubusercontent.com': [/^\/.*/],
  'avatars.githubusercontent.com': [/^\/.*/],
  'camo.githubusercontent.com': [/^\/.*/],
}

// 无 Content-Length 时仍允许写入缓存的域名(通常是小文件)
const SMALL_FILE_HOSTS = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'avatars.githubusercontent.com',
  'camo.githubusercontent.com',
])

// 不转发给上游的请求头
const SKIP_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'cdn-loop', 'accept-encoding', 'content-length',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cf-ew-progress',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
])

// 不回传给客户端的响应头
const SKIP_RES_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
])

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, ctx)
    } catch (err) {
      console.error('gh-proxy error:', err)
      return textResponse('gh-proxy 内部错误: ' + (err?.message || String(err)), 502)
    }
  },
}

async function handleRequest(request, ctx) {
  // CORS 预检直接放行
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
        'access-control-allow-headers': request.headers.get('access-control-request-headers') || '*',
        'access-control-max-age': '86400',
      },
    })
  }

  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/+/, '')

  if (!path || path === 'index.html') return indexPage(url.origin)
  if (path === 'favicon.ico') return new Response(null, { status: 204 })

  // 解析目标地址:支持 /https://github.com/... 与 /github.com/...(协议可省略)
  // 兼容常见笔误:https:/ 单斜杠被吞、https://https:// 协议重复
  const raw = path
    .replace(/^(https?):\/(?!\/)/i, '$1://')
    .replace(/^(?:https?:\/\/)+/i, 'https://')
  let target
  try {
    target = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL('https://' + raw)
  } catch {
    return textResponse('无法解析目标 URL: ' + raw, 400)
  }

  // 便捷重写:github.com 的 blob/raw 页面路径 → raw 文件地址
  target = normalizeTarget(target)
  if (url.search) target.search = url.search

  if (!isAllowed(target)) {
    return textResponse(`不支持代理该地址:${target.hostname} 不在白名单内`, 403)
  }

  // GET 且不带 Range 时优先查边缘缓存
  const cacheable = request.method === 'GET' && !request.headers.get('range')
  if (cacheable) {
    const cached = await caches.default.match(request.url)
    if (cached) return finalizeResponse(cached, 'HIT')
  }

  // https 目标不允许经重定向降级到 http
  const strictHttps = target.protocol === 'https:'
  const upstream = await fetchUpstream(request, request.method, target, strictHttps, 0)

  // 体积允许的 200 响应写入边缘缓存
  if (cacheable && upstream.status === 200) {
    const len = Number(upstream.headers.get('content-length') || 0)
    const sizeOk = (len > 0 && len <= MAX_CACHE_BYTES) || (!len && SMALL_FILE_HOSTS.has(target.hostname))
    if (sizeOk) {
      try {
        ctx.waitUntil(
          caches.default.put(request, upstream.clone()).catch((e) => console.error('cache put failed:', e?.message || e))
        )
      } catch { /* 缓存失败不影响响应 */ }
    }
  }

  return finalizeResponse(upstream, 'MISS')
}

/** 校验目标 URL 是否命中域名/路径白名单 */
function isAllowed(url) {
  const rules = HOST_RULES[url.hostname]
  return !!rules && rules.some((rx) => rx.test(url.pathname))
}

/**
 * 兼容常见写法,避免 403/404:
 * - github.com/user/repo/blob|raw/分支/文件 → raw.githubusercontent.com/user/repo/分支/文件
 * - raw.githubusercontent.com/user/repo/blob/分支/文件 → 剔除误带的 blob 段
 * - www.github.com 等 www 前缀 → 剥离
 */
function normalizeTarget(url) {
  const host = url.hostname.replace(/^www\./i, '')
  if (host !== url.hostname) {
    url = new URL(url.href)
    url.hostname = host
  }
  if (host === 'github.com') {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+\/.+)$/)
    if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`)
  }
  if (host === 'raw.githubusercontent.com') {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+\/.+)$/)
    if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`)
  }
  return url
}

/** 请求上游,并在 Worker 内手动跟随重定向(逐跳校验白名单) */
async function fetchUpstream(request, method, target, strictHttps, depth) {
  const headers = buildUpstreamHeaders(request)
  const init = { method, headers, redirect: 'manual' }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }

  const res = await fetch(target.href, init)

  if (depth < MAX_REDIRECTS && res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    if (location) {
      const next = new URL(location, target)
      if (res.body) { try { res.body.cancel() } catch { /* ignore */ } }
      if (strictHttps && next.protocol !== 'https:') {
        return textResponse(`重定向目标不受支持(不允许降级):${next.href}`, 403)
      }
      if (!isAllowed(next)) {
        return textResponse(`重定向目标不在白名单内:${next.hostname}`, 403)
      }
      // 307/308 保留原方法;301/302/303 按 HTTP 语义转为 GET
      const nextMethod = res.status === 307 || res.status === 308 ? method : (method === 'HEAD' ? 'HEAD' : 'GET')
      return fetchUpstream(request, nextMethod, next, strictHttps, depth + 1)
    }
  }

  return res
}

/** 构造转发给上游的请求头 */
function buildUpstreamHeaders(request) {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    const k = key.toLowerCase()
    if (SKIP_REQ_HEADERS.has(k) || k.startsWith('cf-') || k.startsWith('x-forwarded')) continue
    headers.set(key, value)
  }
  if (!headers.has('user-agent')) headers.set('user-agent', 'gh-proxy-worker/1.0')
  return headers
}

/** 包装上游响应:补充 CORS 与缓存状态头 */
function finalizeResponse(res, cacheStatus) {
  const headers = new Headers(res.headers)
  for (const h of SKIP_RES_HEADERS) headers.delete(h)
  headers.set('access-control-allow-origin', '*')
  headers.set('x-gh-proxy-cache', cacheStatus)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

function textResponse(message, status) {
  return new Response(message + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
  })
}

function indexPage(origin) {
  const base = origin.replace(/[^a-zA-Z0-9:.\-/]/g, '') // 防止 Host 头注入
  // 把后端白名单序列化注入前端,保证页面转换规则与服务端实际行为一致
  const clientRules = JSON.stringify(
    Object.fromEntries(Object.entries(HOST_RULES).map(([host, pats]) => [host, pats.map((p) => p.source)]))
  )
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gh-proxy · GitHub 加速</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:#0d1117;color:#c9d1d9}
main{max-width:820px;margin:0 auto;padding:48px 20px}
h1{font-size:28px;color:#58a6ff;margin:0 0 6px}
h1 span{font-size:14px;color:#8b949e;font-weight:400;margin-left:8px}
.sub{color:#8b949e;margin:0 0 32px}
h2{font-size:18px;margin-top:40px;color:#e6edf3}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#161b22;border:1px solid #30363d;border-radius:6px}
code{padding:2px 6px;font-size:13px;word-break:break-all}
pre{padding:12px 14px;overflow:auto;font-size:13px;line-height:1.7}
ul{padding-left:20px;line-height:1.9}
footer{margin-top:48px;color:#8b949e;font-size:12px}

/* 地址转换卡片 */
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px}
.card label{display:block;font-size:14px;color:#e6edf3;margin-bottom:10px;font-weight:600}
#src{width:100%;padding:12px 14px;font-size:14px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#e6edf3;background:#0d1117;border:1px solid #30363d;border-radius:8px;outline:none;transition:border-color .15s}
#src:focus{border-color:#58a6ff;box-shadow:0 0 0 3px rgba(88,166,255,.15)}
#src::placeholder{color:#484f58}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{padding:5px 12px;font-size:12px;color:#8b949e;background:#0d1117;border:1px solid #30363d;border-radius:999px;cursor:pointer;transition:all .15s}
.chip:hover{color:#58a6ff;border-color:#58a6ff}
#result{margin-top:16px;min-height:56px}
.hint{color:#484f58;font-size:13px;padding:14px 0}
.out{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px 14px}
.out.ok{border-color:#238636}
.out.err{border-color:#da3633}
.out .label{font-size:11px;color:#8b949e;margin-bottom:6px;letter-spacing:.5px}
.out .link{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.6;word-break:break-all}
.out.ok .link a{color:#58a6ff;text-decoration:none}
.out.ok .link a:hover{text-decoration:underline}
.out.err .link{color:#f85149}
.actions{display:flex;gap:10px;margin-top:12px}
.btn{padding:7px 16px;font-size:13px;border-radius:6px;border:1px solid rgba(240,246,252,.1);background:#21262d;color:#e6edf3;cursor:pointer;transition:all .15s}
.btn:hover{background:#30363d}
.btn.primary{background:#238636;border-color:rgba(240,246,252,.1)}
.btn.primary:hover{background:#2ea043}
</style>
</head>
<body>
<main>
<h1>gh-proxy <span>on Cloudflare Workers</span></h1>
<p class="sub">GitHub 反向代理:加速 release、raw、gist、api 及 git clone 等请求,文件经 Cloudflare 边缘节点缓存中转。</p>

<div class="card">
  <label for="src">粘贴 GitHub 链接,自动生成加速地址</label>
  <input id="src" type="text" spellcheck="false" autocomplete="off"
    placeholder="https://github.com/user/repo/releases/download/v1.0/app.zip">
  <div class="chips">
    <button class="chip" type="button" data-fill="https://github.com/user/repo/releases/download/v1.0/app.zip">release 下载</button>
    <button class="chip" type="button" data-fill="https://github.com/user/repo/blob/main/README.md">仓库文件页(blob)</button>
    <button class="chip" type="button" data-fill="https://raw.githubusercontent.com/user/repo/main/README.md">raw 直链</button>
    <button class="chip" type="button" data-fill="https://github.com/user/repo/archive/refs/heads/main.tar.gz">源码包 archive</button>
    <button class="chip" type="button" data-fill="https://api.github.com/repos/user/repo">REST API</button>
  </div>
  <div id="result"><div class="hint">输入后即时转换:支持省略协议、自动纠正 blob 页面链接与重复的 https://</div></div>
</div>

<h2>使用方法</h2>
<p>在任意 GitHub 资源链接前拼接本站地址即可(协议可省略):</p>
<pre>${base}/https://github.com/user/repo/releases/download/v1.0/app.zip
${base}/github.com/user/repo/archive/refs/heads/main.tar.gz
${base}/https://raw.githubusercontent.com/user/repo/main/README.md</pre>
<p>仓库文件页链接(<code>blob</code>)也可以直接使用,会自动转为 raw 文件地址:</p>
<pre>${base}/https://github.com/user/repo/blob/main/README.md</pre>

<h2>加速 git clone</h2>
<pre>git clone ${base}/https://github.com/user/repo.git
git clone ${base}/https://github.com/user/repo.git --depth=1</pre>

<h2>支持的上游</h2>
<ul>
<li><code>github.com</code> 的 <code>releases</code>、<code>archive</code> 路径及 git Smart HTTP(克隆)</li>
<li><code>raw.githubusercontent.com</code>、<code>gist.githubusercontent.com</code>、<code>api.github.com</code>(REST API)</li>
<li><code>codeload.github.com</code>(zip / tar.gz 源码包)</li>
<li><code>objects.githubusercontent.com</code> 等 release 资产域名,以及 <code>avatars</code>、<code>camo</code> 图片域名</li>
</ul>

<footer>本服务仅供个人加速使用,请遵守 GitHub 服务条款与各仓库许可证。</footer>
</main>

<script>
var RULES = ${clientRules};

// 与服务端一致的规范化:修协议笔误 → 剥 www → blob/raw 页面转 raw 直链
function parseInput(s) {
  s = s.trim()
  if (!s) return null
  s = s.replace(/^(https?):\\/(?!\\/)/i, '$1://').replace(/^(?:https?:\\/\\/)+/i, 'https://')
  if (!/^https?:\\/\\//i.test(s)) s = 'https://' + s
  try { return new URL(s) } catch (e) { return null }
}

function normalizeTarget(url) {
  var host = url.hostname.replace(/^www\\./i, '')
  if (host !== url.hostname) {
    url = new URL(url.href)
    url.hostname = host
  }
  if (host === 'github.com') {
    var m = url.pathname.match(/^\\/([^/]+)\\/([^/]+)\\/(?:blob|raw)\\/([^/]+\\/.+)$/)
    if (m) return new URL('https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3])
  }
  if (host === 'raw.githubusercontent.com') {
    var m2 = url.pathname.match(/^\\/([^/]+)\\/([^/]+)\\/blob\\/([^/]+\\/.+)$/)
    if (m2) return new URL('https://raw.githubusercontent.com/' + m2[1] + '/' + m2[2] + '/' + m2[3])
  }
  return url
}

function isAllowed(url) {
  var pats = RULES[url.hostname]
  if (!pats) return false
  for (var i = 0; i < pats.length; i++) {
    if (new RegExp(pats[i]).test(url.pathname)) return true
  }
  return false
}

var srcEl = document.getElementById('src')
var resultEl = document.getElementById('result')

function el(tag, cls, text) {
  var n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function render(state) {
  resultEl.textContent = ''
  if (!state) {
    resultEl.appendChild(el('div', 'hint', '输入后即时转换:支持省略协议、自动纠正 blob 页面链接与重复的 https://'))
    return
  }
  var box = el('div', 'out ' + (state.ok ? 'ok' : 'err'))
  var label = el('div', 'label', state.ok ? '加速地址' : '无法转换')
  var link = el('div', 'link')
  if (state.ok) {
    var a = el('a', null, state.proxied)
    a.href = state.proxied
    link.appendChild(a)
  } else {
    link.textContent = state.error
  }
  box.appendChild(label)
  box.appendChild(link)
  resultEl.appendChild(box)

  if (state.ok) {
    var actions = el('div', 'actions')
    var copyBtn = el('button', 'btn primary', '复制')
    copyBtn.type = 'button'
    copyBtn.addEventListener('click', function () { copyText(state.proxied, copyBtn) })
    var openBtn = el('button', 'btn', '在新标签页打开')
    openBtn.type = 'button'
    openBtn.addEventListener('click', function () { window.open(state.proxied, '_blank', 'noopener') })
    actions.appendChild(copyBtn)
    actions.appendChild(openBtn)
    resultEl.appendChild(actions)
  }
}

function convert() {
  var raw = srcEl.value
  if (!raw.trim()) { render(null); return }
  var url = parseInput(raw)
  if (!url) {
    render({ ok: false, error: '无法解析该地址,请检查是否为完整的 GitHub 链接' })
    return
  }
  var target = normalizeTarget(url)
  if (!isAllowed(target)) {
    var msg
    if (target.hostname === 'github.com') {
      msg = '仅支持 github.com 的 releases / archive / 克隆链接;仓库主页、PR、Issue 等页面请粘贴文件直链或 raw 地址'
    } else {
      msg = '不支持代理 ' + target.hostname + ':不在白名单内'
    }
    render({ ok: false, error: msg })
    return
  }
  render({ ok: true, proxied: location.origin + '/' + target.href })
}

function copyText(t, btn) {
  var done = function () {
    btn.textContent = '已复制'
    setTimeout(function () { btn.textContent = '复制' }, 1500)
  }
  var fallback = function () {
    var ta = document.createElement('textarea')
    ta.value = t
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); done() } catch (e) {}
    document.body.removeChild(ta)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, fallback)
  } else {
    fallback()
  }
}

srcEl.addEventListener('input', convert)
var chips = document.querySelectorAll('.chip')
for (var i = 0; i < chips.length; i++) {
  chips[i].addEventListener('click', function () {
    srcEl.value = this.getAttribute('data-fill')
    convert()
  })
}
srcEl.focus()
</script>
</body>
</html>`
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}
