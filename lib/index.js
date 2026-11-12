// dsh-workbench · node 半（cordis 插件）
//
// 职责：把界面（client 半）的读写，接到 SQLite 数据层上。
//
// 为什么用 connection.fetch.register 而不是 webServer.register：
//   · webServer 是底层 HTTP 路由，**不做鉴权**（源码里 token 零命中）
//   · connection.fetch 是官方「可被客户端 fetch」的通道，自带 403(Host/Origin 围栏) / 401(浏览器鉴权)
//   · ctx.remote.<service> 那套 RPC 底层就是它
//   形状（源码出处 @deepseek-ai/dsh-client-connection/lib/index.js 的 registerFetchRoute）：
//     { path, methods: [...], requestBody: 'buffered', fetch: (request) => Promise<Response> }
//   它是 **Web Fetch 签名**，不是 node 的 (req, res)。
//
// 关于 Config：cordis 的 resolveConfig 是
//     if (!runtime.Config) return config
//     runtime.Config["~standard"].validate(config)
// 所以要么不导出 Config，要么导出 Standard Schema（schemastery）。本插件没有配置项，不导出。
//
// SQLite 访问走 tools/workbench-db.py 的 `api` 子命令（JSON 进 / JSON 出），
// 这样不必给 Electron 编译原生模块（better-sqlite3 会有 ABI 问题）。
// 将来要提速可以换成 node:sqlite（Node 22.5+ 内置）。

import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'dsh-workbench'

/** 需要宿主的 connection 服务（提供带鉴权的 fetch 路由注册）。 */
export const inject = ['connection']

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const WORKSPACE = join(HERE, '..', '..')     // 工作区根（插件目录在 <workspace>/dsh-workbench）
const DB_SCRIPT = join(PLUGIN_ROOT, 'tools', 'workbench-db.py')
const MATERIALS_SCRIPT = join(PLUGIN_ROOT, 'tools', 'gen-materials.py')
const SNAPSHOT_PATH = join(PLUGIN_ROOT, 'lib', 'materials.snapshot.json')

// ── 公众号爆文库 ──
// 单独脚本、单独快照，**不并进 materials**：爆文带正文（实测最长 9534 字），
// 塞进 materials.snapshot.json 会被 gen-catalog.py 烘焙进 client.js，把前端产物撑到几 MB。
// 热榜和爆文的字段、刷新频率、数据量都不一样，分开存、分开取。
const GZH_SCRIPT = join(PLUGIN_ROOT, 'tools', 'collect-gzh.py')
const GZH_SNAPSHOT_PATH = join(PLUGIN_ROOT, 'lib', 'gzh-hot.snapshot.json')

// ── 小红书爆文库 ──
// 同上：25 分类 × 50 条 ≈ 1200 行/天，也必须走独立快照，不能烘进 client.js。
const XHS_SCRIPT = join(PLUGIN_ROOT, 'tools', 'collect-xhs.py')
const XHS_SNAPSHOT_PATH = join(PLUGIN_ROOT, 'lib', 'xhs-hot.snapshot.json')

// ── 生图工作台 ──
const IMAGE_DB_SCRIPT = join(PLUGIN_ROOT, 'tools', 'image-db.py')
const IMAGE_GEN_SCRIPT = join(PLUGIN_ROOT, 'tools', 'image-gen.py')
const IMAGE_OUT_ROOT = join(WORKSPACE, 'image-studio')

/**
 * handraw-style 的安装目录。**不要写死绝对路径**：技能随 git pull / 重装会变位置。
 * 解析顺序：环境变量覆盖 > DSH_HOME/skills/handraw-style > ~/.dsh/skills/handraw-style
 */
function imageSkillRoot() {
  const env = process.env.DSH_WORKBENCH_SKILL_ROOT
  if (env) return env
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'skills', 'handraw-style')
}

/** 归一化索引只在装好技能后变一次，进程内缓存即可。 */
let imageCatalogCache = null
let imageCatalogCacheKey = ''

/**
 * 技能库文件的指纹（mtime + size）。
 *
 * **缓存必须带失效条件。** 原来只缓存、不看源文件，后果是：
 * 技能在 GitHub 更新、用户 pull 下来之后，界面照旧显示旧的风格/图型，
 * **刷新页面也没用** —— 缓存活在 node 进程里，只有重启 DSH 才清。
 * 用户看到的症状是"我明明更新了，怎么没有新风格"。踩过一次。
 *
 * 指纹覆盖 catalog 真正读的那几个文件；改动任何一个都会让缓存作废。
 */
function catalogFingerprint() {
  const base = join(imageSkillRoot(), 'skills', 'handdraw-style-prompter', 'references')
  // 自建风格 / 自建资产**不在 references 下**，但它们同样改变索引内容。
  // 少了这两条：加一个 CS-002 之后界面照旧没有它 —— 改了却像没改，
  // 而且症状和「技能更新没生效」一模一样，很难查。
  const files = [
    join(base, 'styles.json'),
    join(base, 'layouts.json'),
    join(base, 'colors.json'),
    join(base, 'model_capabilities.json'),
    join(imageSkillRoot(), 'images', 'custom', 'styles', 'custom_styles.json'),
    join(imageSkillRoot(), 'images', 'custom', 'custom_assets.js')
  ]
  return files
    .map((p) => {
      try {
        const st = statSync(p)
        return `${Math.round(st.mtimeMs)}:${st.size}`
      } catch {
        return '-'   // 文件不在也计入指纹：从有到无同样必须让缓存失效
      }
    })
    .join('|')
}


/** 每日自动采集的钟点（本地时间）。可用 DSH_WORKBENCH_FETCH_HOUR 覆盖。 */
const FETCH_HOUR = Number(process.env.DSH_WORKBENCH_FETCH_HOUR ?? 22)

/** 本地日期 YYYY-MM-DD（不能用 toISOString：那是 UTC，跨时区会差一天）。 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Python 候选：环境变量 > PATH > 常见安装位置。 */
const PY_CANDIDATES = [
  process.env.DSH_WORKBENCH_PY,
  'python',
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe'),
  'C:/Users/wu136/AppData/Local/Programs/Python/Python312/python.exe'
].filter(Boolean)

function b64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
}

/** 调一次数据层 CLI，返回解析后的 JSON。 */
async function callDb(request) {
  let lastError
  for (const python of PY_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        python,
        ['-X', 'utf8', DB_SCRIPT, 'api', '--payload', b64(request)],
        { timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
      )
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}'
      return JSON.parse(line)
    } catch (error) {
      lastError = error
      if (error && typeof error.stdout === 'string' && error.stdout.trim()) {
        try {
          return JSON.parse(error.stdout.trim().split('\n').filter(Boolean).pop())
        } catch { /* 继续换候选 */ }
      }
    }
  }
  throw lastError ?? new Error('workbench: no python interpreter found')
}

/** 调一次生图数据层 CLI（与 callDb 同构，只换脚本）。 */
async function callImageDb(request) {
  let lastError
  for (const python of PY_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        python,
        ['-X', 'utf8', IMAGE_DB_SCRIPT, 'api', '--payload', b64(request)],
        { timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
      )
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}'
      return JSON.parse(line)
    } catch (error) {
      lastError = error
      if (error && typeof error.stdout === 'string' && error.stdout.trim()) {
        try {
          return JSON.parse(error.stdout.trim().split('\n').filter(Boolean).pop())
        } catch { /* 继续换候选 */ }
      }
    }
  }
  throw lastError ?? new Error('workbench: no python interpreter found')
}

/**
 * 后台起一个生成进程并立即返回。
 *
 * 为什么必须异步：单张出图 30–70 秒（实测），而 fetch 路由不能挂着等这么久，
 * 界面靠轮询 /api/workbench/image-jobs 看进度。
 *
 * stdio 用 'ignore'：生成器自己把日志写进 image-studio/<job>/generation.log，
 * 不靠管道回传（也避开受限环境里管道 stdio 的问题）。
 */
function spawnImageGenerator(jobId) {
  const python = process.env.DSH_WORKBENCH_PY || PY_CANDIDATES[0] || 'python'
  const child = spawn(
    python,
    ['-X', 'utf8', IMAGE_GEN_SCRIPT, 'run', '--job', String(jobId)],
    { cwd: WORKSPACE, detached: true, stdio: 'ignore', windowsHide: true }
  )
  child.unref()
  return child.pid
}

/**
 * 跑一整组分镜（漫画流）。
 * **一个进程跑完整组**，不是每个分镜 spawn 一个：N 个进程各自要重载索引、逐张读盘，
 * 而且串行能让日志按镜序连成一条，出问题好查。
 */
/**
 * 删掉生成物的磁盘文件。
 * **删数据不等于删干净**：数据库行删掉后，image-studio/<jobId>/*.png 会变成孤儿文件 ——
 * 界面上看不见、磁盘上一直留着。所以删除必须同时回收文件，且**只删工作区内的路径**。
 */
async function removeAssetFiles(paths) {
  let n = 0
  for (const p of paths || []) {
    const abs = resolve(String(p || ''))
    if (!abs.startsWith(WORKSPACE + sep)) continue      // 越界一律不碰
    try { await unlink(abs); n += 1 } catch { /* 文件可能已经不在了 */ }
  }
  return n
}

/**
 * 任务已从库里删掉时，把它的整个产物目录也清掉。
 * **只删图片是不够的**：image-studio/<jobId>/ 里还有 generation.log，
 * 目录空不掉，磁盘上会积一堆再也没有入口的残留。
 */
async function removeJobDirs(jobIds) {
  let n = 0
  for (const id of jobIds || []) {
    if (!/^\d+$/.test(String(id))) continue
    const dir = join(WORKSPACE, 'image-studio', String(id))
    if (dir !== WORKSPACE && !dir.startsWith(WORKSPACE + sep)) continue
    try { await rm(dir, { recursive: true, force: true }); n += 1 } catch { /* 忽略 */ }
  }
  return n
}

function spawnSeriesRunner(seriesId) {
  const python = process.env.DSH_WORKBENCH_PY || PY_CANDIDATES[0] || 'python'
  const child = spawn(
    python,
    ['-X', 'utf8', IMAGE_GEN_SCRIPT, 'run-series', '--series', String(seriesId)],
    { cwd: WORKSPACE, detached: true, stdio: 'ignore', windowsHide: true }
  )
  child.unref()
  return child.pid
}

/**
 * 回收卡死的任务：进程被杀 / DSH 重启后，running 会永远挂着。
 * 规则与公众号那条一致（见 ANALYSIS_PROMPT 的 10 分钟复位）。
 * 带节流：轮询会反复进这里，但没必要每次真的查一遍库。
 */
let lastReapAt = 0
async function reapStaleImageJobs(minutes = 15) {
  if (Date.now() - lastReapAt < 60000) return 0
  lastReapAt = Date.now()
  const cutoff = new Date(Date.now() - minutes * 60000)
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())} ` +
    `${p(cutoff.getHours())}:${p(cutoff.getMinutes())}:${p(cutoff.getSeconds())}`
  try {
    const r = await callImageDb({ op: 'image-reap', cutoff: stamp, minutes })
    return r.reaped ?? 0
  } catch {
    return 0
  }
}

/**
 * 极简 Markdown → HTML。只覆盖本套件会产出的子集：
 *   # / ## / ### 标题、**加粗**、*斜体*、> 引用块、- 列表、
 *   ![alt](src "title") 图片占位、段落。
 * 先转义 HTML 再做标记替换，避免正文里的尖括号变成标签。
 * 排版阶段产出的 article.html 会直接走另一条路径（真排版），不经过这里。
 */
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')

  const out = []
  const lines = md.split(/\r?\n/)
  let para = []
  let quote = []
  let list = []

  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join('')) + '</p>'); para = [] } }
  const flushQuote = () => {
    if (quote.length) {
      out.push('<blockquote>' + quote.map((q) => '<p>' + inline(q) + '</p>').join('') + '</blockquote>')
      quote = []
    }
  }
  const flushList = () => {
    if (list.length) {
      out.push('<ul>' + list.map((q) => '<li>' + inline(q) + '</li>').join('') + '</ul>')
      list = []
    }
  }
  const flushAll = () => { flushPara(); flushQuote(); flushList() }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') { flushAll(); continue }

    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/)
    if (img) {
      flushAll()
      const alt = img[1] || ''
      const caption = img[3] || ''
      out.push('<figure class="wb-ph"><div class="wb-ph-box">配图占位</div><figcaption>'
        + inline(alt) + (caption ? '<span class="wb-cap">' + inline(caption) + '</span>' : '')
        + '</figcaption></figure>')
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flushAll(); out.push(`<h${h[1].length}>` + inline(h[2]) + `</h${h[1].length}>`); continue }

    if (line.startsWith('>')) { flushPara(); flushList(); quote.push(line.replace(/^>\s?/, '')); continue }
    if (/^[-*+]\s+/.test(line)) { flushPara(); flushQuote(); list.push(line.replace(/^[-*+]\s+/, '')); continue }

    flushQuote(); flushList(); para.push(line)
  }
  flushAll()
  return out.join('\n')
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
}

/** 把 HTML 里的相对图片路径改写成走资源路由，否则浏览器读不到宿主磁盘上的文件。 */
function rewriteAssetUrls(html, draftPath) {
  const base = draftPath.endsWith('/') ? draftPath : draftPath + '/'
  return html.replace(/(src|href)="(?!https?:|\/|data:)([^"]+)"/g,
    (mm, attr, rel) => `${attr}="/api/workbench/asset?p=${encodeURIComponent(base + rel)}"`)
}

/**
 * 抓一次热榜归档（跑 tools/gen-materials.py），返回结果与最新快照。
 * 热点是动态更新的：同一天不同时刻抓到的榜单不一样，所以这里允许反复调用，
 * 每次都会覆盖当天的归档并刷新 fetchedAt。
 */
async function runMaterialsFetch() {
  let lastError
  for (const python of PY_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(
        python, ['-X', 'utf8', MATERIALS_SCRIPT],
        { timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: WORKSPACE }
      )
      const log = `${stdout || ''}${stderr || ''}`.trim().split('\n').filter(Boolean).slice(-8)
      let snapshot = null
      try {
        snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'))
      } catch { /* 没产出快照也不要紧，下面照样返回日志 */ }
      return { ok: true, log, snapshot }
    } catch (error) {
      lastError = error
    }
  }
  return {
    ok: false,
    error: String((lastError && lastError.message) || lastError || 'no python interpreter found'),
    log: String((lastError && lastError.stdout) || '').split('\n').filter(Boolean).slice(-6)
  }
}

/**
 * 抓一次公众号 10w+ 爆文（跑 tools/collect-gzh.py），返回结果与最新快照。
 *
 * 与热榜的区别：公众号榜单每天 18:30 才同步**前一天**的数据，同一天重复抓结果不变，
 * 所以不需要"同一天反复覆盖"的语义；但允许用户手动重抓（补抓漏掉的分类）。
 * 22 个分类串行请求，实测约 98 秒，超时给到 300 秒。
 */
async function runGzhFetch(opts = {}) {
  const args = ['-X', 'utf8', GZH_SCRIPT]
  const payload = {}
  if (opts.days) payload.days = Number(opts.days)
  if (Array.isArray(opts.categories) && opts.categories.length) payload.categories = opts.categories
  if (Object.keys(payload).length) args.push(JSON.stringify(payload))

  let lastError
  for (const python of PY_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(
        python, args,
        { timeout: 300000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: WORKSPACE }
      )
      const log = `${stdout || ''}${stderr || ''}`.trim().split('\n').filter(Boolean).slice(-8)
      let snapshot = null
      try {
        snapshot = JSON.parse(await readFile(GZH_SNAPSHOT_PATH, 'utf8'))
      } catch { /* 没产出快照也不要紧，下面照样返回日志 */ }
      return { ok: true, log, snapshot }
    } catch (error) {
      lastError = error
    }
  }
  return {
    ok: false,
    error: String((lastError && lastError.message) || lastError || 'no python interpreter found'),
    log: String((lastError && lastError.stdout) || '').split('\n').filter(Boolean).slice(-6)
  }
}

/**
 * 采集小红书每日爆款 → lib/xhs-hot.snapshot.json
 *
 * 和公众号爆文一样，单独一个快照文件而不是并进 materials：
 * 25 个分类 × 50 条 ≈ 1200 行，烘进 client.js 会把前端产物再撑大 1~2 MB。
 * 接口按「日期 + 分类」直接给榜单，25 个分类串行实测约 90 秒（单次请求约 3.5 秒）。
 * 超时给到 600 秒：默认只采 1 天，但补采 7 天时是 175 次请求、实测 616 秒，
 * 300 秒会在补历史时直接掐断，而那时已经采到的部分会被丢掉。
 */
async function runXhsFetch(opts = {}) {
  const args = ['-X', 'utf8', XHS_SCRIPT]
  const payload = {}
  if (opts.days) payload.days = Number(opts.days)
  if (Array.isArray(opts.categories) && opts.categories.length) payload.categories = opts.categories
  if (Object.keys(payload).length) args.push(JSON.stringify(payload))

  let lastError
  for (const python of PY_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(
        python, args,
        { timeout: 600000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, cwd: WORKSPACE }
      )
      const log = `${stdout || ''}${stderr || ''}`.trim().split('\n').filter(Boolean).slice(-8)
      let snapshot = null
      try {
        snapshot = JSON.parse(await readFile(XHS_SNAPSHOT_PATH, 'utf8'))
      } catch { /* 没产出快照也不要紧，下面照样返回日志 */ }
      return { ok: true, log, snapshot }
    } catch (error) {
      lastError = error
    }
  }
  return {
    ok: false,
    error: String((lastError && lastError.message) || lastError || 'no python interpreter found'),
    log: String((lastError && lastError.stdout) || '').split('\n').filter(Boolean).slice(-6)
  }
}

/**
 * 爆文库快照的读取（公众号 / 小红书共用）。
 *
 * **为什么分三种模式**：小红书 7 天全量是 8399 行 / 8.3 MB。整份塞给浏览器会
 * 卡住首屏（JSON.parse 8 MB 在主线程上是肉眼可见的停顿），也没法进 localStorage
 * （配额 ~5 MB，setItem 直接抛 QuotaExceededError）。所以：
 *   ?meta=1   → 只给日期清单 + 每天条数（几百字节），驱动日期选择器
 *   ?date=X   → 只给这一天的行，表格用
 *   不带参数  → 整份快照（兼容老调用方 / 调试）
 * 三种模式都统一返回 `ok:true`，没采过时给空骨架而不是 404，界面才好渲染空态。
 */
async function viralGet(request, snapshotPath, label) {
  const url = new URL(request.url, 'http://x')
  const wantMeta = url.searchParams.get('meta') === '1'
  const wantDate = url.searchParams.get('date') || ''

  let snapshot = null
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  } catch (error) {
    const empty = { byDate: {}, dates: [], categories: [], fetchedAt: '', today: localDate() }
    if (wantMeta) return json({ ok: true, meta: { dates: [], counts: {}, latest: '', fetchedAt: '' }, empty: true, today: localDate() })
    if (wantDate) return json({ ok: true, rows: [], date: wantDate, empty: true, today: localDate() })
    return json({
      ok: true, snapshot: empty, empty: true, today: localDate(),
      hint: `还没有${label}快照（${String(error?.code || 'ENOENT')}），点「采集爆文」抓昨天的榜单`
    })
  }

  const byDate = snapshot.byDate || {}
  const dates = (snapshot.dates || Object.keys(byDate)).slice().sort()
  const counts = {}
  dates.forEach((d) => { counts[d] = (byDate[d] || []).length })
  const meta = {
    dates, counts,
    latest: dates.length ? dates[dates.length - 1] : '',
    fetchedAt: snapshot.fetchedAt || '',
    categories: snapshot.categories || []
  }

  if (wantMeta) return json({ ok: true, meta, today: localDate() })
  if (wantDate) return json({ ok: true, rows: byDate[wantDate] || [], date: wantDate, meta, today: localDate() })
  return json({ ok: true, snapshot, meta, today: localDate() })
}

/**
 *
 * **日常的定时采集交给 DSH 的「自动化任务」**（见 README 第五节）：
 *   · DSH 的调度是**存盘的**，重启后仍在，且能补投递错过的发生
 *   · 插件进程内的 setTimeout 是纯内存的，DSH 一关就没了
 * 所以这里只保留"打开就保证今天有数据"这一件事——零成本、静默，
 * 补上"DSH 在采集时刻没开"的缺口。真正的每日仪式由自动化任务负责（它还能做对比分析）。
 */
function ensureTodayArchive(ctx) {
  const log = (msg) => ctx.logger?.info?.(`dsh-workbench: ${msg}`)
  readFile(SNAPSHOT_PATH, 'utf8').then((t) => {
    const last = ((JSON.parse(t).dates) || []).slice(-1)[0]
    if (last && last < localDate()) {
      log(`快照最新是 ${last}，今天 ${localDate()}，20 秒后补采一次`)
      const timer = setTimeout(async () => {
        const r = await runMaterialsFetch()
        log(r.ok
          ? `补采完成 fetchedAt=${(r.snapshot && r.snapshot.fetchedAt) || '?'}`
          : `补采失败: ${r.error}`)
      }, 20000)
      if (timer.unref) timer.unref()
    } else {
      log(`快照已是今天（${last}），跳过补采`)
    }
  }).catch(() => { /* 还没有快照，等自动化任务或手动采集 */ })
}

/**
 * 跑一次 Python 脚本并拿回 stdout（带解释器候选回退）。
 * 生图相关的两个脚本都走这里，避免每个路由各写一遍候选循环。
 */
async function execPython(script, args, timeout = 120000) {
  let lastError
  for (const python of PY_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        python, ['-X', 'utf8', script, ...args],
        { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, cwd: WORKSPACE }
      )
      return stdout
    } catch (error) {
      // 脚本以非 0 退出时的两条信息通道都要读：
      //   · stdout —— 脚本自己写的结构化错误 JSON（业务错误，如「图型不存在」）
      //   · stderr —— **argparse 的用法错误只写这里**（如「--theme: expected one argument」）
      // 只读 stdout 会让最常见的一类错误（参数没填 / 参数写错）退化成
      // 「Command failed: <整条命令行>」—— 用户看到一条命令行，既不知道错在哪也看不懂。
      const out = (error && typeof error.stdout === 'string') ? error.stdout.trim() : ''
      if (out) return out
      const err = (error && typeof error.stderr === 'string') ? error.stderr.trim() : ''
      if (err) {
        const lines = err.split('\n').map((l) => l.trim()).filter(Boolean)
        // argparse 最后一行是真正的错因，前面是 usage；两个都给，界面按需展示
        return JSON.stringify({ ok: false, error: lines[lines.length - 1] || err, usage: err })
      }
      lastError = error
    }
  }
  throw lastError ?? new Error('workbench: no python interpreter found')
}

function lastJson(stdout) {
  const text = String(stdout || '').trim()
  // 优先整段解析（脚本可能缩进输出）；失败再退到「最后一行」，
  // 因为有些脚本会先打日志、最后一行才是 JSON。
  try { return JSON.parse(text) } catch { /* 继续 */ }
  const line = text.split('\n').filter(Boolean).pop() ?? '{}'
  return JSON.parse(line)
}

/**
 * 组装 image-gen.py preview 的参数。
 * **单图创作与漫画流共用这一份** —— 两条路各写一遍参数转发，必然有一条先漏字段。
 */
function previewArgsFor(body) {
  const args = ['preview', '--theme', String(body.theme || ''),
                '--with-ref', body.withRef === false ? '0' : '1']
  if (body.styleId) args.push('--style', String(body.styleId))
  if (body.colorId) args.push('--color', String(body.colorId))
  if (body.layoutId) args.push('--layout', String(body.layoutId))
  if (body.mode) args.push('--mode', String(body.mode))
  if (body.ratio) args.push('--ratio', String(body.ratio))
  if (body.whitespace) args.push('--whitespace', String(body.whitespace))
  if (body.mood) args.push('--mood', String(body.mood))
  if (body.textReq) args.push('--text', String(body.textReq))
  if (body.subject) args.push('--subject', String(body.subject))
  if (body.constraint) args.push('--constraint', String(body.constraint))
  if (body.textLayout) args.push('--text-layout', String(body.textLayout))
  // 风格融合：给了场景风格就走融合路径（独立技能、独立拼装，不是加几行）
  if (body.fusionOn && body.sceneStyle) args.push('--scene-style', String(body.sceneStyle))
  // 角色/道具/场景基准图：不依赖风格库（见 build_bare_prompt）
  if (body.noStyle) args.push('--no-style')
  if (body.model) args.push('--model', String(body.model))
  if (body.redraw) args.push('--redraw')
  // 资产垫图可多选，来源有两处：技能目录（自建资产基准图）与工作区（本次上传的商品图）。
  // ⚠️ **必须同时做越界检查和存在性检查**：只查越界是不够的 ——
  //    上传图的相对路径是工作区相对的（image-studio/_uploads/x.png），
  //    而它在技能根下**同样"越界合法"却并不存在**；只查越界会把它解析到技能根，
  //    任务随后以一个莫名其妙的错误失败。先按存在性挑，挑不到就不传（宁可不传，不传错）。
  const assetImgs = Array.isArray(body.assetImgs) ? body.assetImgs : []
  if (assetImgs.length) {
    const base = imageSkillRoot()
    for (const img of assetImgs) {
      const s = String(img)
      const cands = isAbsolute(s) ? [s] : [resolve(base, s), resolve(WORKSPACE, s)]
      for (const abs of cands) {
        const inSkill = abs !== base && abs.startsWith(base + sep)
        const inWs = abs !== WORKSPACE && abs.startsWith(WORKSPACE + sep)
        if (!inSkill && !inWs) continue
        if (!existsSync(abs)) continue
        args.push('--asset-ref', abs)
        break
      }
    }
  }
  return args
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection?.fetch?.register === undefined) {
    ctx.logger?.warn?.('dsh-workbench: connection.fetch 不可用，数据层路由未挂载')
    return
  }

  /** 准入：连接层已鉴权，这里再查一次作为防御（签名不匹配时不阻断）。 */
  const rejected = (request) => {
    try {
      const verdict = connection.admit(request)
      return verdict && verdict.rejection !== undefined ? verdict.rejection : undefined
    } catch {
      return undefined
    }
  }

  // 选题库读写：GET 列表，POST 加 / 删 / 改状态
  //
  // ⚠️ 路径必须挂在 /api 前缀下。原因（已实测）：
  //   connection 把 createSharedFetchHandler(API_PATH) 挂在 API_PATH = "/api" 这个 prefix 路由上，
  //   而它用 fetchRoutes.get(url.pathname) 做**完整路径名精确匹配**。
  //   所以注册在 /api 之外的路径（比如 /dsh-workbench/...）根本不会被匹配，
  //   请求会落到前端托管的兜底处理器 → GET 404 / POST 405。
  //   DSH 自己的范例就是 path: "/api/file"（dsh-api-session-controller）。
  //   匹配顺序：fetchRoutes 命中优先于 api-gateway 的 interceptor，所以不会被网关截走。
  connection.fetch.register({
    path: '/api/workbench/topics',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        if (request.method === 'GET') {
          return json(await callDb({ op: 'list-topics' }))
        }
        const body = await request.json()
        if (body.action === 'delete') {
          return json(await callDb({ op: 'delete-topic', id: body.id }))
        }
        if (body.action === 'set-status') {
          return json(await callDb({ op: 'set-topic', id: body.id, status: body.status }))
        }
        // 手工加一个选题方案（更常见的是经 jobs 队列由选题 skill 分析产出）
        return json(await callDb({
          op: 'add-topic',
          title: body.title,
          track: body.track,
          skill: body.skill,
          persona: body.persona,
          kind: body.kind,
          angle: body.angle,
          bestTitle: body.bestTitle
        }))
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }
  })

  // 待分析队列（两段式的第一段）：素材库点【入选题库】只写这里，不当场产生选题
  connection.fetch.register({
    path: '/api/workbench/jobs',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        if (request.method === 'GET') {
          return json(await callDb({ op: 'list-jobs' }))
        }
        const body = await request.json()
        if (body.action === 'take') {
          // 指定 id 时精确取那一条（用户在界面上点的那条），否则 FIFO
          return json(await callDb({ op: 'take-job', id: body.id }))
        }
        return json(await callDb({
          op: 'enqueue-job',
          title: body.title,
          platform: body.platform,
          hot: body.hot,
          url: body.url,
          materialDate: body.date,
          sourceKey: body.key,
          track: body.track,
          preset: body.preset,          // ← 弹窗里填的预设，必须转发给数据层
          note: body.note
        }))
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }
  })

  // 文字风格库：GET 列表（?kind=personal|system|sub|all）；POST 新建 / 更新 / 删除 / 投票 / 计数
  //
  // 与生图工作台的「风格库」区分：那个是**图片画风**（367 个 handraw 风格，按 style_id 引用），
  // 这个是**文字语气**（写作 skill 之下的变体）。两者都叫「风格库」但维度不同，
  // 所以路由与表都独立，不做合并。
  connection.fetch.register({
    path: '/api/workbench/styles',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url, 'http://x')
          const kind = url.searchParams.get('kind') || 'all'
          const code = url.searchParams.get('code')
          if (code) return json(await callDb({ op: 'get-style', code }))
          return json(await callDb({ op: 'list-styles', kind }))
        }
        const body = await request.json()
        if (body.action === 'delete') {
          return json(await callDb({ op: 'delete-style', code: body.code }))
        }
        if (body.action === 'vote') {
          return json(await callDb({ op: 'vote-style', code: body.code, up: !!body.up }))
        }
        if (body.action === 'use') {
          return json(await callDb({ op: 'use-style', code: body.code }))
        }
        // 新建 / 更新：带 code 就是更新，不带就是新建
        // 2026-11-05 起风格正文只有一项：bodyMd（一整段 Markdown）。
        // 之前那堆 metrics/profile/lexicons/canon 字段已废弃，不再透传。
        return json(await callDb({
          op: 'save-style',
          code: body.code,
          name: body.name,
          kind: body.kind,
          desc: body.desc,
          track: body.track,
          bodyMd: body.bodyMd,
          source: body.source
        }))
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }
  })

  // 创作库：GET 列表；POST 建草稿 / 回写（状态推进、字数、封面、审稿结果…）
  connection.fetch.register({
    path: '/api/workbench/drafts',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url, 'http://x')
          const status = url.searchParams.get('status') || undefined
          return json(await callDb({ op: 'list-drafts', status }))
        }
        const body = await request.json()
        if (body.action === 'delete') {
          return json(await callDb({ op: 'delete-draft', id: body.id }))
        }
        if (body.action === 'create') {
          // 建草稿：skill 可以前端手工指定（创作配置里选），也可以留空由数据层按赛道自动路由。
          // theme / materials / requirement 是创作配置的三段原文，必须原样透传——
          // 数据层会把它们存进 drafts 表，写作 skill 从表里读，不经过任何摘要改写。
          return json(await callDb({
            op: 'create-draft',
            topicId: body.topicId,
            title: body.title,
            digest: body.digest,
            viewpoint: body.viewpoint,
            track: body.track,
            skill: body.skill,
            skillClass: body.skillClass,
            theme: body.theme,
            materials: body.materials,
            requirement: body.requirement,
            config: body.config
          }))
        }
        // 其余按回写处理（status / words / path / cover / digest / reviewIssues…）
        return json(await callDb(Object.assign({ op: 'set-draft' }, body)))
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }
  })

  // 发布管理：先只读
  connection.fetch.register({
    path: '/api/workbench/publishes',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        return json(await callDb({ op: 'list-publishes' }))
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }
  })

  // 草稿全文：界面点「全文」时读宿主上的 markdown（前端读不了本地文件）
  connection.fetch.register({
    path: '/api/workbench/draft-content',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        const id = new URL(request.url, 'http://x').searchParams.get('id')
        const listed = await callDb({ op: 'list-drafts' })
        const draft = (listed.drafts || []).find((d) => String(d.id) === String(id))
        if (!draft) return json({ ok: false, error: `草稿 #${id} 不存在` }, 404)
        if (!draft.path) return json({ ok: false, error: '这篇还没有草稿目录' }, 404)

        // 路径穿越防护：必须在工作区内
        const dir = resolve(WORKSPACE, draft.path)
        if (dir !== WORKSPACE && !dir.startsWith(WORKSPACE + sep)) {
          return json({ ok: false, error: '路径越界，拒绝读取' }, 403)
        }
        // 先读 markdown 源码：源码视图与「复制源码」都要它。
        // （原先只在 markdown 分支返回 text；走 article.html 时 text 为空，
        //   于是源码视图空白、两个复制按钮都复制不到内容。）
        let source = null
        let sourceName = ''
        for (const name of ['article.md', 'draft.md']) {
          try {
            source = await readFile(join(dir, name), 'utf8')
            sourceName = draft.path + name
            break
          } catch { /* 换下一个候选文件名 */ }
        }
        // 再读排版产物：有 article.html 用它（真排版），否则用 markdown 现场转
        try {
          const raw = await readFile(join(dir, 'article.html'), 'utf8')
          return json({
            ok: true, file: draft.path + 'article.html', kind: 'html',
            html: rewriteAssetUrls(raw, draft.path),
            text: source || '', sourceFile: sourceName, words: draft.word_count
          })
        } catch { /* 还没排版，走 markdown 渲染 */ }
        if (source !== null) {
          return json({
            ok: true, file: sourceName, kind: 'markdown',
            html: mdToHtml(source), text: source, sourceFile: sourceName, words: draft.word_count
          })
        }
        return json({ ok: false, error: '目录里找不到 article.html / article.md / draft.md' }, 404)
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }
  })

  // 草稿资源（配图）：浏览器读不到宿主磁盘文件，由这里按路径读出二进制
  connection.fetch.register({
    path: '/api/workbench/asset',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        const rel = new URL(request.url, 'http://x').searchParams.get('p') || ''
        const full = resolve(WORKSPACE, rel)
        if (full !== WORKSPACE && !full.startsWith(WORKSPACE + sep)) {
          return new Response('forbidden', { status: 403 })
        }
        const ext = full.slice(full.lastIndexOf('.')).toLowerCase()
        const buf = await readFile(full)
        return new Response(buf, {
          headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' }
        })
      } catch (error) {
        return new Response('not found', { status: 404 })
      }
    }
  })

  // 素材库归档：GET 读快照（实时，不再依赖构建时烘焙），POST 立刻抓一次
  connection.fetch.register({
    path: '/api/workbench/materials',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'))
        return json({ ok: true, snapshot, scheduleHour: FETCH_HOUR, today: localDate() })
      } catch (error) {
        return json({ ok: false, error: `读不到素材快照：${String(error?.message ?? error)}` }, 404)
      }
    }
  })

  // 公众号爆文库：GET 读快照（列表页首屏就有数据），POST 触发一次采集
  //
  // 为什么不做成「打开就自动抓」：22 个分类串行要 98 秒、且是付费额度，
  // 每次进素材库都抓一遍既慢又费钱。榜单每天 18:30 才更新一次，
  // 同一天抓第二次拿到的还是一模一样的数据 —— 所以只给手动按钮 + 快照缓存。
  connection.fetch.register({
    path: '/api/workbench/gzh',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      if (request.method === 'POST') {
        let body = {}
        try { body = await request.json() } catch { /* 空 body 合法：全量抓 */ }
        const r = await runGzhFetch({
          days: body && body.days,
          categories: body && body.categories
        })
        return json(Object.assign({ today: localDate() }, r), r.ok ? 200 : 500)
      }
      return viralGet(request, GZH_SNAPSHOT_PATH, '公众号爆文')
    }
  })

  // 小红书爆文库：GET 读快照 / POST 采集。与 /gzh 同构。
  connection.fetch.register({
    path: '/api/workbench/xhs',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      if (request.method === 'POST') {
        let body = {}
        try { body = await request.json() } catch { /* 空 body 合法：全量抓 */ }
        const r = await runXhsFetch({
          days: body && body.days,
          categories: body && body.categories
        })
        return json(Object.assign({ today: localDate() }, r), r.ok ? 200 : 500)
      }
      return viralGet(request, XHS_SNAPSHOT_PATH, '小红书爆文')
    }
  })

  // 手动采集：热点是动态的，同一天可以重复抓，覆盖当天归档
  connection.fetch.register({
    path: '/api/workbench/fetch',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      const r = await runMaterialsFetch()
      return json(Object.assign({ today: localDate(), scheduleHour: FETCH_HOUR }, r),
                  r.ok ? 200 : 500)
    }
  })

  // 手动投料：用户贴一段文字 / 传截图 → 落盘 → 由界面触发 Agent 分析
  connection.fetch.register({
    path: '/api/workbench/inbox',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        const body = await request.json()
        const text = String((body && body.text) || '').trim()
        const images = Array.isArray(body && body.images) ? body.images : []
        if (!text && images.length === 0) {
          return json({ ok: false, error: '文字和图片至少给一样' }, 400)
        }
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const dir = join(WORKSPACE, 'materials', 'inbox')
        await mkdir(dir, { recursive: true })
        const saved = []
        for (let i = 0; i < images.length; i++) {
          const img = images[i] || {}
          const m = String(img.dataUrl || '').match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i)
          if (!m) continue
          const buf = Buffer.from(m[2], 'base64')
          if (buf.length > 12 * 1024 * 1024) continue          // 单张上限 12MB
          const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
          const name = `${stamp}-${i + 1}.${ext}`
          const full = join(dir, name)
          await writeFile(full, buf)
          saved.push({ name, path: full, bytes: buf.length, original: String(img.name || '') })
        }
        const record = { id: stamp, createdAt: new Date().toISOString(), text, images: saved, dir }
        await writeFile(join(dir, stamp + '.json'), JSON.stringify(record, null, 2), 'utf8')
        return json({ ok: true, record })
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }
  })

  // 自检：数据层是否可达
  connection.fetch.register({
    path: '/api/workbench/health',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        const res = await callDb({ op: 'counts' })
        return json({ ok: true, db: DB_SCRIPT, counts: res.counts })
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error), db: DB_SCRIPT }, 500)
      }
    }
  })

  // ── 生图工作台 ──────────────────────────────────────────────────────
  //
  // 与公众号那套的关系：**同一份 SQLite、同一套鉴权路由机制，另外三个表**。
  // 生图与写稿是两条流水线，共用宿主能力，不共用业务表。

  // 1) 归一化索引：风格 324 / 图型 161 / 色卡 36 / 角色。
  //    路径解析（gallery 相对路径 → 技能根相对路径）只在 image-gen.py 里做一次，
  //    界面与生成器共用，避免两处各写一套换算而慢慢漂移。
  connection.fetch.register({
    path: '/api/workbench/image-catalog',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      // ?layout=SC-001 → 只回这一个图型的完整资料（中英原文 + 实际会追加的后缀）。
      // 挂在这里而不是新开路由：161 个图型原文共 165 KB，全塞进初始索引会让首屏包体翻倍，
      // 而用户一次只看一个。
      const reqUrl = new URL(request.url, 'http://x')
      // ?decision=FA-018&model=… → 能力判定（要不要特征词 / 要不要垫图）。
      // 界面在选中风格后自动查这个，不该让人点按钮才看得到。
      const decisionStyle = reqUrl.searchParams.get('decision')
      if (decisionStyle) {
        if (!/^[A-Za-z]{2}-\d{3}$/.test(decisionStyle)) {
          return json({ ok: false, error: 'bad style id' }, 400)
        }
        const args = ['decision', '--style', decisionStyle]
        const mdl = reqUrl.searchParams.get('model')
        if (mdl) args.push('--model', mdl)
        try {
          return json(lastJson(await execPython(IMAGE_GEN_SCRIPT, args, 30000)))
        } catch (error) {
          return json({ ok: false, error: String((error && error.message) || error) }, 404)
        }
      }
      const layoutId = reqUrl.searchParams.get('layout')
      if (layoutId) {
        if (!/^[A-Za-z]{2}-\d{3}$/.test(layoutId)) {
          return json({ ok: false, error: 'bad layout id' }, 400)
        }
        try {
          const out = await execPython(IMAGE_GEN_SCRIPT, ['layout', '--id', layoutId], 30000)
          return json(lastJson(out))
        } catch (error) {
          return json({ ok: false, error: String((error && error.message) || error) }, 404)
        }
      }
      // 指纹变了就作废缓存 —— 技能更新后不必重启 DSH（见 catalogFingerprint）
      const catalogFp = catalogFingerprint()
      if (imageCatalogCache && imageCatalogCacheKey === catalogFp) return json(imageCatalogCache)
      try {
        const out = await execPython(IMAGE_GEN_SCRIPT, ['catalog'], 60000)
        const catalog = lastJson(out)
        if (catalog && catalog.ok) {
          imageCatalogCache = catalog
          imageCatalogCacheKey = catalogFp
        }
        return json(catalog)
      } catch (error) {
        return json({ ok: false, error: String((error && error.message) || error),
                      skillRoot: imageSkillRoot() }, 500)
      }
    }
  })

  // 2) 图片二进制。浏览器读不到宿主磁盘，必须由这里读出来。
  //    from=skill 读技能安装目录（编号参考图、图型缩略图、色卡），
  //    from=workspace 读工作区（生成物）。
  //    ⚠️ 两个根都要做越界检查——只查一个根等于没查。
  connection.fetch.register({
    path: '/api/workbench/image-asset',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        const u = new URL(request.url, 'http://x')
        const rel = u.searchParams.get('p') || ''
        const from = u.searchParams.get('from') || 'skill'
        const bases = { skill: imageSkillRoot(), workspace: WORKSPACE }
        const base = bases[from]
        if (!base) return new Response('bad origin', { status: 400 })
        const full = resolve(base, rel)
        if (full !== base && !full.startsWith(base + sep)) {
          return new Response('forbidden', { status: 403 })
        }
        const ext = full.slice(full.lastIndexOf('.')).toLowerCase()
        const buf = await readFile(full)
        // 技能参考图在一次安装内是不可变的，让浏览器缓存住：
        // 风格库一屏几十张缩略图，每次开面板都重新读盘会很钝。
        // 生成物（workspace）不缓存——同一个 job 目录可能被重跑覆盖。
        const cc = from === 'skill' ? 'public, max-age=3600' : 'no-cache'
        return new Response(buf, {
          headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cc }
        })
      } catch (error) {
        return new Response('not found', { status: 404 })
      }
    }
  })

  // 3) 生图任务：GET 列表（连资产与用量一起给，界面只轮询这一个口），
  //    POST action=preview 只组提示词，action=enqueue 入队。
  connection.fetch.register({
    path: '/api/workbench/image-jobs',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        if (request.method === 'GET') {
          const u = new URL(request.url, 'http://x')
          const jobId = u.searchParams.get('id')
          const reaped = await reapStaleImageJobs()
          const jr = await callImageDb({ op: 'image-list-jobs', limit: 60 })
          const ar = await callImageDb(jobId
            ? { op: 'image-list-assets', jobId: Number(jobId), limit: 40 }
            : { op: 'image-list-assets', limit: 120 })
          let usage = null
          try { usage = await callImageDb({ op: 'image-usage' }) } catch { /* 用量拿不到不算失败 */ }
          return json({ ok: true, jobs: jr.jobs || [], assets: ar.assets || [], usage, reaped })
        }

        const body = await request.json()
        const action = body.action || 'enqueue'

        // 删除：数据库删行 + 回收磁盘文件。两者缺一都会留下垃圾 ——
        // 只删库会留下看不见的孤儿 PNG，只删文件会让列表里挂着打不开的条目。
        if (action === 'delete-asset') {
          const r = await callImageDb({ op: 'asset-delete', assetId: Number(body.assetId || 0) })
          if (!r.ok) return json(r, 400)
          const filesRemoved = await removeAssetFiles(r.files)
          // 任务的最后一张被删掉时，连产物目录一起清（里面还有 generation.log）
          if (r.jobRemoved) await removeJobDirs([r.jobId])
          imageCatalogCache = null
          return json({ ok: true, filesRemoved, jobRemoved: !!r.jobRemoved })
        }
        if (action === 'delete-series') {
          const r = await callImageDb({ op: 'series-delete', seriesId: Number(body.seriesId || 0) })
          if (!r.ok) return json(r, 400)
          const filesRemoved = await removeAssetFiles(r.files)
          await removeJobDirs(r.jobIds)
          imageCatalogCache = null
          return json({ ok: true, filesRemoved, jobCount: r.jobCount })
        }

        // ── 主题润色：**只返回建议，由界面让用户确认** ──
        // 必须放在组提示词之前：润色不需要风格/图型，还没选风格时也该能用。
        // 自动替换主题等于把用户写的东西悄悄改掉 —— 那比不润色更糟，
        // 用户会以为"模型理解错了"，而其实是我们在中途换掉了他的输入。
        if (action === 'polish-theme') {
          const src = String(body.theme || '').trim()
          if (!src) return json({ ok: false, error: 'theme required' }, 400)
          try {
            return json(lastJson(await execPython(
              IMAGE_GEN_SCRIPT, ['polish', '--theme', src], 90000)))
          } catch (error) {
            return json({ ok: false, error: String((error && error.message) || error) }, 500)
          }
        }

        // 提示词只在 Python 里组一次，preview 与真实出图共用，避免两套模板
        const built = lastJson(await execPython(IMAGE_GEN_SCRIPT, previewArgsFor(body), 60000))

        if (action === 'preview') return json(built)

        if (!String(body.theme || '').trim()) {
          return json({ ok: false, error: 'theme required' }, 400)
        }
        if (!body.styleId && !body.noStyle) {
          return json({ ok: false, error: 'styleId required（先到风格库选一个编号）' }, 400)
        }

        const saved = await callImageDb({
          op: 'image-enqueue',
          theme: String(body.theme).trim(),
          styleId: body.styleId,
          layoutId: body.layoutId || null,
          colorId: body.colorId || null,
          promptZh: built.promptZh,
          promptEn: built.promptEn,
          refPath: built.refPath || null,
          assetRefPaths: built.assetRefs || [],
          params: {
            mode: built.mode || body.mode || 'pure-image',
            ratio: body.ratio || '', whitespace: body.whitespace || '',
            mood: body.mood || '', subject: body.subject || '',
            textReq: body.textReq || '', constraint: body.constraint || '',
            fusionOn: !!body.fusionOn, sceneStyle: body.sceneStyle || '',
            noStyle: !!body.noStyle,
            textLayout: body.textLayout || '',
            outMode: body.outMode || '',
            redraw: !!body.redraw
          },
          model: built.model,
          size: body.size || built.size,
          quality: body.quality || built.quality,
          withRef: body.withRef !== false,
          arms: body.arms === 'both' ? 'both' : (body.withRef === false ? 'text' : 'ref'),
          note: body.note || null
        })
        if (!saved.ok) return json(saved, 400)
        // 同时给出 jobId：调用方不必猜 id 藏在返回结构的哪一层。
        // 少给这一个字段，就会有人写成 `r.jobId` 拿到 undefined —— 已经踩过。
        return json({ ok: true, jobId: saved.job.id, job: saved.job,
                      promptZh: built.promptZh, promptEn: built.promptEn })
      } catch (error) {
        return json({ ok: false, error: String((error && error.message) || error) }, 500)
      }
    }
  })

  // 4) 真正出图。**这一步是异步的**：单张 30–70 秒，不能挂在请求里等。
  //    起一个后台进程，界面靠轮询 image-jobs 看状态。
  connection.fetch.register({
    path: '/api/workbench/image-run',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        const body = await request.json()
        const jobId = Number(body.jobId || 0)
        if (!jobId) return json({ ok: false, error: 'jobId required' }, 400)
        const taken = await callImageDb({ op: 'image-take', jobId })
        if (!taken.ok) return json(taken, 400)
        const pid = spawnImageGenerator(jobId)
        return json({ ok: true, jobId, pid })
      } catch (error) {
        return json({ ok: false, error: String((error && error.message) || error) }, 500)
      }
    }
  })

  // 6) 资产库（角色 / 道具 / 场景）。
  //    数据源是**技能自带的 custom_library_manager**（全局配置 ~/.handraw-style/config.json
  //    + 外部图库目录 + library.json），**不落 SQLite** —— 同一份资产存两处，迟早对不上。
  //    这里只做转发：init 挂载目录、save 把工作区里的生成物归档进去。
  connection.fetch.register({
    path: '/api/workbench/image-assets',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        if (request.method === 'GET') {
          return json(lastJson(await execPython(IMAGE_GEN_SCRIPT, ['assets'], 60000)))
        }
        // 请求体解析单独兜住：上传的商品图可能很大，解析失败时要给出**能指向原因**的报错，
        // 而不是让它掉进下面的 catch 变成一句笼统的 500。
        let body
        try {
          body = await request.json()
        } catch (e) {
          return json({
            ok: false,
            error: '请求体不是合法 JSON（上传图片时通常是体积过大）',
            detail: String((e && e.message) || e)
          }, 400)
        }
        const action = body.action || ''
        const KNOWN_ACTIONS = ['init', 'save', 'upload']

        if (action === 'init') {
          const dir = String(body.path || '').trim()
          if (!dir) return json({ ok: false, error: 'path required' }, 400)
          const out = lastJson(await execPython(
            IMAGE_GEN_SCRIPT, ['asset-init', '--path', dir], 120000))
          imageCatalogCache = null
          return json(out)
        }

        if (action === 'save') {
          const category = String(body.category || '')
          const name = String(body.name || '').trim()
          if (!['characters', 'props', 'scenes'].includes(category)) {
            return json({ ok: false, error: 'bad category' }, 400)
          }
          if (!name) return json({ ok: false, error: 'name required' }, 400)
          // 生成物的 relPath 是相对工作区的，先转绝对路径并做越界检查，再交给技能的数据层
          const abs = resolve(WORKSPACE, String(body.relPath || ''))
          if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + sep)) {
            return json({ ok: false, error: 'forbidden' }, 403)
          }
          // save_asset 会转 webp、写外部图库、同步镜像并刷新画廊
          const out = lastJson(await execPython(IMAGE_GEN_SCRIPT,
            ['asset-save', '--category', category, '--name', name, '--image', abs], 120000))
          return json(out)
        }

        // 删除自建资产：复用技能自带 delete_asset（它会同步 library.json、镜像与画廊）
        if (action === 'remove') {
          const id = String(body.id || '').trim().toUpperCase()
          if (!/^[A-Z]{2,3}-\d{3}$/.test(id)) return json({ ok: false, error: 'bad asset id' }, 400)
          const out = lastJson(await execPython(
            IMAGE_GEN_SCRIPT, ['asset-delete', '--id', id], 120000))
          imageCatalogCache = null
          return json(out)
        }

        // 「本次上传」参考图：商品图 / 临时参考图。
        // **与「存入资产库」是两件事**：这里只落盘到工作区的一个临时目录，不进图库、不进索引、
        // 不进挑选器。电商单品图这种「就用这一次」的素材不该污染长期资产库。
        if (action === 'upload') {
          const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(body.data || ''))
          if (!m) return json({ ok: false, error: 'data 必须是 dataURL 图片' }, 400)
          const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
          const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64')
          if (!buf.length) return json({ ok: false, error: '图片是空的' }, 400)
          if (buf.length > 12 * 1024 * 1024) return json({ ok: false, error: '图片过大（上限 12MB）' }, 400)
          const dir = join(WORKSPACE, 'image-studio', '_uploads')
          await mkdir(dir, { recursive: true })
          // 文件名只保留中文/字母/数字/点/横线，长度截断 —— 不信任浏览器给的名字
          const stem = String(body.name || 'upload').replace(/\.[a-z0-9]+$/i, '')
            .replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 36) || 'upload'
          const file = join(dir, `${Date.now()}-${stem}.${ext}`)
          await writeFile(file, buf)
          return json({ ok: true, relPath: relative(WORKSPACE, file).split(sep).join('/'),
                        bytes: buf.length, name: stem })
        }

        // 走到这里说明 action 不认识。**最常见的原因是 node 半没重启**：
        // 客户端 bundle 会随页面刷新更新，而 node 半是 DSH 启动时载入的 ——
        // 于是界面是新的、服务端是旧的，表现就是「界面有按钮、点了报 unknown action」。
        // 所以这里把已知动作和该怎么做都写出来，别让人对着三个字猜。
        return json({
          ok: false,
          error: 'unknown action: ' + (action || '(空)'),
          knownActions: KNOWN_ACTIONS,
          hint: '如果你刚更新过插件：请**完全退出 DSH 再启动**（只刷新页面不够 —— node 半不会重新载入）。'
        }, 400)
      } catch (error) {
        return json({ ok: false, error: String((error && error.message) || error) }, 500)
      }
    }
  })

  // 7) 漫画流：一次创作 = 一组分镜。
  //    拆解（确定性切分）与执行（一个进程跑完整组）都在 Python 侧，
  //    这里只负责把分镜写成任务、把跑批进程拉起来。
  //    ⚠️ 确定性切分解决不了「一句话拆 5 个场景」——那是语义创作，得让 Agent 做；
  //       拆不够时 sp.meta.short 为真，界面据此提示，而不是假装拆成功了。
  connection.fetch.register({
    path: '/api/workbench/image-series',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        if (request.method === 'GET') {
          const u = new URL(request.url, 'http://x')
          const id = u.searchParams.get('id')
          return json(await callImageDb(id
            ? { op: 'series-get', seriesId: Number(id) }
            : { op: 'series-list', limit: 20 }))
        }

        const body = await request.json()
        const action = body.action || 'preview'

        if (action === 'run') {
          const sid = Number(body.seriesId || 0)
          if (!sid) return json({ ok: false, error: 'seriesId required' }, 400)
          return json({ ok: true, seriesId: sid, pid: spawnSeriesRunner(sid) })
        }

        // sourceText **不能在这里就拦** —— 显式面板（客户端已经把分镜拆好了：
        // 智能分镜、电商配方的多图）根本不需要原文，它把每一格的文字直接交过来。
        // 原来这道检查挡在所有分支前面，于是「用智能分镜拆完再开始创作」
        // 必然报 sourceText required：明明分镜就在手上，却被告知「先贴文案」。
        const source = String(body.sourceText || '').trim()

        // 分镜的两种来源：
        //   · 显式面板 —— 电商详情页多图：**配方是技能自带的 EC 图型序列**，
        //     商品信息不是要"切开的文本"，而是要"换图型逐一呈现的内容"，
        //     所以由客户端给出每张的文案 + 图型，不走文本切分。
        //   · 文本切分 —— 漫画流：按空行段落 / 句子确定性拆分。
        const explicit = Array.isArray(body.panels)
          ? body.panels.filter((p) => p && String(p.text || '').trim()) : null
        let panels, splitMeta
        if (explicit && explicit.length) {
          panels = explicit.map((p, i) => ({
            index: i + 1,
            // 对白**并入画面描述**：技能侧的提示词只有一个「主题」入口，
            // 不为它新开通道；要显示的字就写成这一格的内容要求。
            // 客户端已经把「要不要画进格子」决定过了，这里只负责转成文本。
            // 去掉画面描述末尾已有的句号再拼，否则会出现「生活。。画面里」
            text: String(p.text).replace(/[。.]$/, '') + (String(p.dialogue || '').trim()
              ? '。画面里要显示这句对白：「' + String(p.dialogue).trim() + '」' : ''),
            layoutId: p.layoutId || ''
          }))
          splitMeta = { source: 'recipe', produced: panels.length,
                        requested: panels.length, short: false, auto: false }
          if (action === 'preview') {
            return json({ ok: true, panels: panels.map((p) => p.text), meta: splitMeta,
                          layoutIds: panels.map((p) => p.layoutId) })
          }
        } else {
          // 只有这条路才真的需要原文 —— 检查放在需要它的地方
          if (!source) {
            return json({ ok: false, error: 'sourceText required（先贴商品信息 / 文案）' }, 400)
          }
          // 拆解两条路线，**由调用方选**，不在这里替它决定：
          //   默认 = 确定性切分：免费、可复现，但只会在已有句子边界上切。
          //   smart = 语义分镜：让文本模型理解内容后重新组织每一格画面，
          //           能处理「一句话要拍五格」（确定性拆解这时会 meta.short）。
          const splitArgs = ['split', '--text', source, '--count', String(body.count || 0)]
          if (body.smart) splitArgs.push('--smart')
          // 语义分镜要走一次文本模型，30 秒不够（实测单次可到 20 秒以上，
          // 内容长时更久），失败会表现为「拆解失败」而不是超时，很难查。
          const sp = lastJson(await execPython(IMAGE_GEN_SCRIPT, splitArgs,
                                                body.smart ? 120000 : 30000))
          if (action === 'preview') return json(sp)
          if (!sp.ok) return json(sp, 400)
          panels = (sp.panels || []).map((t, i) => ({ index: i + 1, text: t, layoutId: '' }))
          splitMeta = sp.meta || {}
        }
        if (!panels.length) return json({ ok: false, error: '内容为空，拆不出分镜' }, 400)
        if (!body.styleId) return json({ ok: false, error: 'styleId required（先选风格）' }, 400)

        // 2) 组词：只为拿 model / size / 解析后的资产垫图；参数转发与单图共用同一份
        // 主题**必须有值**：显式面板路径（智能分镜 / 电商配方）可能没有 sourceText，
        // 这时用第一格的文字当代表。给空串会让组词直接失败，表现为
        // 「开始创作报错」但看不出跟分镜有关。
        const themeForBuild = source || String((panels[0] && panels[0].text) || '').slice(0, 200)

        // 人物一致性锚点：cast 是智能分镜提炼出的**全片固定外形**。
        // 并进系列 constraint 就够了 —— 每格任务的 params 是整组共享的
        // （image-db.py: `params_json = s["params_json"]`），8 格自动全带上，
        // 不用改逐格注入。不加角色资产时，这是防「同一个人每格长得不一样」的兜底。
        const castText = (Array.isArray(body.cast) ? body.cast : [])
          .filter((c) => c && String(c.name || '').trim() && String(c.desc || '').trim())
          .map((c) => String(c.name).trim() + '（' + String(c.desc).trim() + '）')
          .join('；')
        const fullConstraint = [String(body.constraint || '').trim(),
                                castText ? '全片人物形象固定为：' + castText : '']
          .filter(Boolean).join('；')

        const built = lastJson(await execPython(IMAGE_GEN_SCRIPT, previewArgsFor(
          Object.assign({}, body, { theme: themeForBuild, constraint: fullConstraint })), 60000))

        // 3) 建系列 + 写分镜任务
        const created = await callImageDb({
          op: 'series-create',
          title: body.title || '', sourceText: source,
          panelTotal: panels.length, splitMeta,
          styleId: body.styleId, colorId: body.colorId || null, layoutId: body.layoutId || null,
          params: {
            mode: built.mode || body.mode || 'pure-image',
            ratio: body.ratio || '', whitespace: body.whitespace || '',
            mood: body.mood || '', subject: body.subject || '',
            // 用合并后的 constraint（含人物锚点）：只改组词那处的话，
            // 会出现「预览里有、每格真出图没有」——正是这次要修的问题。
            textReq: body.textReq || '', constraint: fullConstraint,
            fusionOn: !!body.fusionOn, sceneStyle: body.sceneStyle || '',
            noStyle: !!body.noStyle,
            textLayout: body.textLayout || '',
            outMode: body.outMode || '',
            redraw: !!body.redraw
          },
          withRef: body.withRef !== false,
          assetRefPaths: built.assetRefs || [],
          model: built.model, size: built.size, quality: built.quality
        })
        if (!created.ok) return json(created, 400)
        const sid = created.series.id
        const queued = await callImageDb({
          op: 'series-panels', seriesId: sid, panels
        })
        if (!queued.ok) return json(queued, 400)
        return json({ ok: true, seriesId: sid, panelCount: panels.length,
                      meta: splitMeta, short: !!splitMeta.short })
      } catch (error) {
        return json({ ok: false, error: String((error && error.message) || error) }, 500)
      }
    }
  })

  // 5) 计费账本：接口没有配额端点（/v1/models 与配额接口都是 404），只能本地记。
  connection.fetch.register({
    path: '/api/workbench/image-usage',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const bad = rejected(request)
      if (bad !== undefined) return json({ ok: false, error: 'unauthorized' }, bad)
      try {
        return json(await callImageDb({ op: 'image-usage' }))
      } catch (error) {
        return json({ ok: false, error: String((error && error.message) || error) }, 500)
      }
    }
  })

  // 每日自动采集热点（只在 DSH 运行期间有效）
  ensureTodayArchive(ctx)
}
