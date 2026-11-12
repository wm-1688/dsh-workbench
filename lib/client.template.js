// dsh-workbench · client 半
//
// 两个工作台（公众号 / 生图）+ 技能库，各一个 main 面板 + 侧栏菜单项。
// 每日热榜：7 天热榜归档（localStorage）
// 选题库 / 创作库 / 发布管理：**直接读写 SQLite**，走 node 半挂的官方 fetch 路由
//   GET  /api/workbench/topics          列选题
//   POST /api/workbench/topics          加 / 删 / 改状态
//   GET  /api/workbench/drafts          创作库
//   GET  /api/workbench/publishes       发布管理
//   GET  /api/workbench/health          数据层自检
// 同源相对路径，所以不需要知道宿主端口；鉴权由 connection 层处理。
//
// 机制契约（从可工作插件 @nagi-ovo/dsh-visualize 与 DSH 源码读出，写错就不渲染）：
//   0. register(options, Component) 的 options 必须带 name = 槽位名
//   1. sidebar.panellist 是 list 型 → { name, id, label, order }
//   2. main 是 chain/key 型 → { name, key, label }，且 key === 侧栏 id
//   3. 侧栏条目组件只渲染在 panelGlyph 里，是图标：props { size, active }
//   4. activePanelId 为 null 时 main 回落到 conversation

window.__ModuleLoader__.load({
	id: 'dsh-workbench',
	factory: (e) => {
		const React = e('react')
		const h = React.createElement

		/**
		 * 面板级错误边界。
		 * **渲染期抛异常时 React 会卸载整棵子树** —— 表现就是"白屏、什么都没有"，
		 * 而真正的原因只存在于浏览器控制台里，界面上看不到任何线索。
		 * 加这一层把错误显示在面板上：白屏变成一张能读的错误卡。
		 */
		class PanelBoundary extends React.Component {
			constructor(props) {
				super(props)
				this.state = { error: null }
			}
			static getDerivedStateFromError(error) {
				return { error }
			}
			componentDidCatch(error, info) {
				console.error('[dsh-workbench] 面板渲染出错', error, info)
			}
			render() {
				if (!this.state.error) return this.props.children
				const e = this.state.error
				return h('div', {
					style: {
						padding: '22px', font: '13px/1.75 system-ui, -apple-system, "Segoe UI", sans-serif',
						color: 'var(--dsw-alias-label-primary)', overflow: 'auto', height: '100%'
					}
				},
					h('div', { style: { fontWeight: 700, fontSize: '15px', marginBottom: '6px', color: '#b42318' } },
						'工作台渲染出错'),
					h('div', { style: { fontSize: '12.5px', opacity: 0.75, marginBottom: '10px' } },
						'下面是错误原文（按 F12 在控制台可看到完整堆栈）。把这段发我就能定位。'),
					h('pre', {
						style: {
							whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', lineHeight: '1.6',
							padding: '11px 13px', borderRadius: '8px', maxHeight: '52vh', overflow: 'auto',
							background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)',
							border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)'
						}
					}, String((e && e.stack) || e)),
					h('button', {
						type: 'button',
						style: {
							marginTop: '12px', padding: '7px 16px', borderRadius: '8px', cursor: 'pointer',
							border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'transparent',
							color: 'inherit', font: 'inherit'
						},
						onClick: () => this.setState({ error: null })
					}, '重试渲染'))
			}
		}


		// ── 构建时快照：技能注册表 + 工作台技能包 + 素材归档（由 tools/build.py 生成） ──
		// SKILL_REGISTRY 是「资产视图」：系统里装了什么、各自被哪些流水线引用（单一来源）。
		// SKILL_PACKS 是「流程视图」：每个工作台的阶段编排，技能元数据引用同一份。
		const SKILL_REGISTRY = __REGISTRY_JSON__
		const SKILL_PACKS = __PACKS_JSON__
		const MATERIALS = __MATERIALS_JSON__

		function fmtHot(v) {
			const n = Number(v)
			if (!isFinite(n) || n <= 0) return '—'
			if (n >= 100000000) return (n / 100000000).toFixed(1) + ' 亿'
			if (n >= 10000) return (n / 10000).toFixed(1) + ' 万'
			return String(n)
		}

		// ── 数据层客户端：调 node 半的官方 fetch 路由 ──
		async function apiGet(path) {
			const res = await fetch(path, { credentials: 'same-origin' })
			let data = null
			try { data = await res.json() } catch (err) { /* 非 JSON */ }
			if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
			if (data && data.ok === false) throw new Error(data.error || 'unknown error')
			return data
		}
		async function apiPost(path, body) {
			const res = await fetch(path, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
			let data = null
			try { data = await res.json() } catch (err) { /* 非 JSON */ }
			if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
			if (data && data.ok === false) throw new Error(data.error || 'unknown error')
			return data
		}

		// ── 触发 Agent 跑选题分析 ──
		// 用官方远程方法 session.prompt（schema 出处 dsh-api-session-controller/lib/typert.host.js）：
		//   { requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text',text}], clientTimeZone? }
		//   → { accepted: true }
		// 注意 ctx.remote.* 返回统一信封 {ok, value} / {ok:false, error}，要解包。
		// ── 赛道（genre）：每篇不同，决定路由到哪个 skill ──
		// ⚠️ 与「账号定位」是两回事：
		//   账号定位 = config.yaml 的 article_category（社会文化观察），全局固定，只影响语气与审稿尺度
		//   赛道     = 每篇一个，存在 track 字段里，**决定选哪个选题/写作技能**
		// 2026-10-09 之前两者被混为一谈：route_writing 拿账号定位去匹配关键词，永远匹配不上，
		// 于是所有赛道都落到默认 A 类，B 类写作技能的分流形同死代码。
		// 8 个赛道，由平台分类体系的 43 个分类归并而来（2026-10-09）。
		// 只有「娱乐与情感」和「AI 与科技」会改变技能路由；其余走同一套，
		// 分开是为了库里能筛选、以及让 Agent 知道该往哪个方向找角度。
		const GENRES = [
			'社会民生', '娱乐与情感', 'AI 与科技', '国际与时事',
			'财经与商业', '文化与生活', '体育与健康', '教育与职场'
		]

		// 选它表示「不预设」：track 存空串，由 Agent 在选题时按标题判断。
		// 为什么要这个选项：关键词预填实测会误判（如「俄…」「张本美和…」），
		// 一个错的默认值比没有默认值更糟——用户可能不看就提交了。
		const AUTO_GENRE = '自动判断（由 Agent 按标题定）'

		// ── 创作配置：写作技能候选 ──
		// 与技能包第 5 段「写正文」的成员表一致，**不再按赛道自动路由**：
		// 自动路由的老逻辑是「娱乐/AI 类走 B，其余走 A」，实测会把用户想用的技能挡掉，
		// 而且 B 类技能过不了 A 类的 aws 配额门禁，选错了要到审稿阶段才暴露。
		// 现在改成用户在这里手工选，选完就按这个写，不再猜。
		// klass：A 类过 aws 配额门禁（导语 80-128 字等），B 类跳过。
		// 写作技能清单。
		// 按「能不能从零写出一篇稿」分三组——这是能不能放进「创作配置」的唯一判据：
		//   from_zero  给主题/素材即可产出全文，适合当写稿技能
		//   rewrite    必须先有稿才能改，放进创作配置会误导
		//   other      不产出稿子（蒸馏风格、出标题…）
		// 每个 name 都必须在 skills 目录里真实存在，build.py 会逐个校验。
		// ── 写作技能清单 ────────────────────────────────────────────────
		//
		// 【什么技能能进这里】
		// 必须是「写作方法论」型技能：只规定怎么写，接受「主题+素材+角度」作为输入，
		// 输出一份 Markdown 正文。redfox 那类「工具型」技能（自带安装步骤、
		// 输入是关键词、输出直接到 article.md）不能进——与本项目管线冲突，已移除：
		//   · wechat-write      输入是关键词，自己抓爆款写，不读用户素材
		//   · visual-ops-writer 自带配图并直接产出 article.md，与 finalize 管线重复
		//
		// 【新增一个写作技能要做的事】
		// 1. 把技能装到 .dsh/skills 或 ~/.dsh/skills，确认有 SKILL.md
		// 2. 在下面加一项，字段含义见 REQUIRED_SKILL_FIELDS
		// 3. 跑 python dsh-workbench/tools/build.py --no-fetch
		//    它会校验 name 真实存在、covers 值合法、klass 只能是 A/B
		// 4. 想让它默认配某个风格，填 defaultStyle 为风格 code（如 MS-006）
		//
		// 【covers 怎么填】对照 SKILL.md 的步骤，看它自带骨架哪几步：
		//   load 准备 / digest 吃透素材 / angle 定角度 / outline 出骨架
		//   write 写正文 / check 自检 / deliver 交付
		// 没自带的，骨架会在写作指令里标注「必须补上」，Agent 会照做。
		const SKELETON_KEYS = ['load', 'digest', 'angle', 'outline', 'write', 'check', 'deliver']
		const REQUIRED_SKILL_FIELDS = {
			name: '技能目录名，必须与 SKILL.md 所在目录同名',
			title: '界面上显示的中文短名',
			klass: 'A 或 B。A 要过 aws 配额门禁；B 跳过配额、用自己的检查器',
			kind: 'from_zero 能从零写稿（才进创作配置）/ rewrite 改写已有 / other 不写稿',
			covers: '自带骨架哪几步，取值见 SKELETON_KEYS',
			hint: '一句话说明，显示在按钮下方',
			defaultStyle: '可选。选此技能时自动切到该风格 code',
		}

		const WRITING_SKILLS = [
			{ name: 'aws-wechat-article-writing', title: '公众号写稿', klass: 'A', kind: 'from_zero',
			  // aws 自带 ①②⑤⑥⑦（准备/吃透素材/写正文/自检/交付），缺 ③定角度 ④出骨架
			  covers: ['load', 'digest', 'write', 'check', 'deliver'],
			  hint: '通用长文写作，从主题或提纲生成完整初稿；要过 aws 配额门禁' },
			{ name: 'write-entertainment-wechat-articles', title: '娱乐成稿', klass: 'B', kind: 'from_zero',
			  // 娱乐套件有自己完整的叙事规范，默认配「娱乐叙事体」
			  defaultStyle: 'MS-007',
			  // 娱乐套件最完整：13 步覆盖了骨架全部 7 个阶段，骨架对它只是复核
			  covers: ['load', 'digest', 'angle', 'outline', 'write', 'check', 'deliver'],
			  hint: '娱乐/情感题材专用，把素材写成有场景有叙事的成稿' },
			{ name: 'khazix-writer', title: '卡兹克长文', klass: 'B', kind: 'from_zero',
			  // 选这个技能默认带上卡兹克风格：技能与风格同源，成套用才对
			  defaultStyle: 'MS-006',
			  // 卡兹克有「第一步理解素材(HKR)」「结构模板」，但没写「准备」和「交付确认」
			  covers: ['digest', 'angle', 'outline', 'write', 'check'],
			  hint: '卡兹克风格：观点锐利、节奏快、爱用短句' },
		]

		// 【已移除的技能】2026-11-07 清理。保留记录，避免以后又被人加回来：
		//   wechat-write            输入是关键词不是素材，自己抓爆款写，与骨架②冲突
		//   visual-ops-writer       自带配图并直接产出 article.md，与 finalize 管线重复
		//   wechat-rewrite          需要先有文案才能改，不是从零写
		//   multi-rewrite           同上，多平台改写需先有稿
		//   multi-copywrite-alchemy 产出风格提示词而非稿件，属于「风格库」的活
		// 判据：能不能只给「主题+素材+角度」就产出一份完整正文。不能的都不进。

		// 创作配置只列「能从零写稿」的；改写类需先有稿，其他不产出稿件。
		const WRITABLE_SKILLS = WRITING_SKILLS.filter((s) => s.kind === 'from_zero')


		// 字数预设：与截图里的短文/中等/长文三档一致，滑杆可再细调。
		const WORD_PRESETS = [
			{ key: 'short', label: '短文', min: 300, max: 500 },
			{ key: 'medium', label: '中等', min: 1200, max: 1500 },
			{ key: 'long', label: '长文', min: 2000, max: 2500 }
		]

		// 创作风格已改为**从风格库读取**（/api/workbench/styles），不再是写死的预设。
		// 原来那五个写死的字符串从来没进过写作指令，选了也不生效，已删除。

		/** 按来源平台 + 标题关键词预填赛道；用户在弹窗里可改，**改了就以用户的为准**。 */
		function guessGenre(row) {
			const s = String((row && row.title) || '')
			const p = String((row && row.platform) || '')
			// 娱乐与情感：会切到 B 类写作技能，判据要收得紧一点
			if (/明星|恋情|结婚|离婚|塌房|绯闻|综艺|演员|歌手|夫妻|婆媳|情感|网红|直播|出轨|复合|官宣|影视|剧|动漫|搞笑|段子/.test(s)) return '娱乐与情感'
			// AI 与科技：AIHOT 两个频道直接归这类，另外命中技术词也归
			if (p === 'AI·热点' || p === 'AI·资讯') return 'AI 与科技'
			// 注意：标题里出现「AI」不一定就是 AI 赛道——「网传X系AI编造」是辟谣新闻，归社会民生。
			if (/AI 编造|AI造谣|系AI|AI生成.*谣言/.test(s)) return '社会民生'
			if (/AI|大模型|芯片|算法|机器人|算力|开源|编程|开发者|数码|手机|电脑|科学|航天|量子|诺贝尔/.test(s)) return 'AI 与科技'
			if (/美国|日本|俄罗斯|俄|乌克兰|外交|联合国|欧洲|中东|总统|以色列|伊朗|朝鲜|军事|军演|俄乌|加沙|对华|高市早苗|岸田|特朗普|普京|泽连斯基|欧盟|北约|停火|也门/.test(s)) return '国际与时事'
			if (/股|基金|房价|楼市|财报|营收|融资|上市|消费|税率|工资|经济|商业|创业|公司|企业|汽车|新能源车/.test(s)) return '财经与商业'
			if (/国足|球|赛季|夺冠|奥运|全运|运动员|冠军|比赛|健身|养生|健康|医疗|疾病|药|疫苗|育儿|孩子|教育|高考|考研|学校|老师/.test(s)) return '体育与健康'
			if (/职场|上班|加班|裁员|求职|跳槽|工资|副业|成长|自律|效率|时间管理/.test(s)) return '教育与职场'
			if (/文化|历史|文物|博物馆|古籍|诗|书|电影|展览|美食|菜|旅游|景区|摄影|生活|家居|宠物|非遗/.test(s)) return '文化与生活'
			return '社会民生'
		}
		const ANALYSIS_PROMPT = [
			'[工作台自动触发] 从素材生成选题 · 四步加工流程。',
			'',
			'**这次不是让技能自由发挥，而是走固定四步。** 四个入口（自动分析 / 热榜手工 / 爆文库 / 新增素材）共用这一套。',
			'',
			'## 第一步：准备',
			'1) 跑 `python dsh-workbench/tools/workbench-db.py list-jobs --status running`；有超过 10 分钟未更新的 running 任务先复位成 pending。',
			'2) 跑 `python dsh-workbench/tools/topic-pipeline.py --job <id>`（单条）或 `--date <日期>`（每日批量）。',
			'   它会在 `_tmp/topic-prompts/` 下写出加工指令，每份含：素材信息、是否需要搜原文、该从哪两个方向切。',
			'',
			'## 第二步：逐份加工（核心）',
			'',
			'读每一份 `_tmp/topic-prompts/*.md`，严格按里面的四步做：',
			'',
			'**① 补全素材**（指令里标了「必做」才做）',
			'   标题信息量不足时，用 web_search 搜原文，拿到：时间、地点、当事人原话、具体数字、事情经过。',
			'   搜不到就明说「搜不到」，不要编。',
			'',
			'**② 拆解素材**',
			'   逐条列：已知事实（时间/人物/数字/原话/动作）、缺口（写作前还要补什么）、公共命题（2-3 个候选）。',
			'   「公共命题」是关键——它比事件本身大一层。',
			'   例：「赵丽颖哄自己上班」→ ① 上班的普遍痛苦 ② 成年人靠自我哄骗维持运转 ③ 明星的接地气也是表演',
			'',
			'**③ 定方向（差异化在这里）**',
			'   指令里指定了 2 个方向（共情/拆解/反差/代价/时间/旁观）。',
			'   **硬要求：两个方向必须对同一批事实给出不同解读。**',
			'   如果两个选题读起来是同一个调性、只换了措辞，就是没做到差异化，重写。',
			'',
			'**④ 出选题**',
			'   每个方向产出 1 个选题，必须带齐：',
			'   · 3 个候选标题（混合风格：数字/对比/原话/悬念）',
			'   · 公共命题、方向',
			'   · **读者为什么点**——具体到内心独白，不要「想了解」这种空话',
			'   · **读完多知道什么**——不能是「知道了这件事」，要「理解了什么」',
			'   · **为什么会转发**——转发时他会说什么话',
			'   · 四维评分：情绪势能 / 差异化 / 受众基数 / 时效窗口，各 0-5 分',
			'',
			'   **及格线**：情绪势能 ≥3 或 受众基数 ≥3',
			'   **优秀线**：及格 且 差异化 ≥3',
			'   不合格的选题不要提交。',
			'',
			'## 第三步：落库',
			'',
			'把产出的 JSON 存成文件，然后跑：',
			'```',
			'python dsh-workbench/tools/topic-pipeline.py --save --json <你写的json路径> --track <赛道>',
			'```',
			'它会校验并写进 topics 表，同时打印每个选题的及格情况。',
			'',
			'## 第四步：回报',
			'',
			'简短说明：加工了几条素材、产出几个选题、各自什么方向、评分多少。',
			'不要展开写正文，也不要顺手建草稿——写作技能由用户在创作配置里手选。',
			'',
			'**每日批量目标**：10 条素材 × 2 个方向 = 20 个选题。不足就如实报数，不硬凑。'
		].join('\n')

		// ── 创作库阶段机（对应流水线 5→11 段） ──
		// draftbox 与 published 分开：进微信草稿箱 ≠ 已群发给读者。
		const DRAFT_STAGES = ['queued', 'draft', 'polished', 'reviewed', 'formatted', 'illustrated', 'draftbox', 'published']
		const DRAFT_LABEL = {
			queued: '待写', draft: '初稿', polished: '已打磨', reviewed: '已审稿',
			formatted: '已排版', illustrated: '已配图', draftbox: '已入草稿箱', published: '已群发'
		}
		// 阶段动作名。2026-11-10 改：formatted 从「配图」改成「插入图位」。
		// 配图改为用户手工发起（右侧独立的「配图」按钮），
		// 避免文章还要改的时候就烧掉一次生图额度。
		const DRAFT_ACTION = {
			queued: '开始写', draft: '打磨', polished: '审稿',
			reviewed: '排版', formatted: '插入图位', illustrated: '入草稿箱'
		}
		function nextStage(status) {
			const i = DRAFT_STAGES.indexOf(status)
			return i >= 0 && i < DRAFT_STAGES.length - 1 ? DRAFT_STAGES[i + 1] : null
		}

		// 写作阶段指令：按 skill / skill_class 决策，A 类要过 aws 配额门禁
		const WRITING_PROMPT = [
			'[工作台自动触发] 处理创作库。步骤：',
			'1) 跑 `python dsh-workbench/tools/workbench-db.py list-drafts` 看当前有哪些稿子、各自什么阶段。',
			'2) 阶段推进规则（drafts.status）：queued → draft → polished → reviewed → formatted → illustrated → draftbox → published',
			'   · queued     初稿：按该草稿的 skill 写全文，落盘到 drafts/{YYYYMMDD}-{slug}/',
			'   · draft      打磨：**lieflat-less-ai-tone**（白名单式）——11 条规则逐条比对，',
			'                没命中规则的句子必须逐字保留，不许顺便润色；末尾有验收清单要逐项复查；',
			'                信息守恒：每个实词都要能在原文指出出处，不许新增或删减事实。',
			'                **A 类**还要过 write.py check 的配额（导语 80-128 字、加粗频率、金句格式）；',
			'                **B 类跳过**该配额（娱乐与情感 / AI 与科技 / 教育与职场）。',
			'                不用自己判断该跑哪套，跑一条命令即可（它按草稿的 skill 选尺子）：',
			'                `python dsh-workbench/tools/check-all.py drafts/{日期}-{slug} --stage=draft`',
			'                它把符号/事实/结构/质感/内容质检/选题对齐一次跑完，按草稿的 skill 自动选尺子。',
			'   · polished   审稿：先跑 `python dsh-workbench/tools/check-all.py drafts/{日期}-{slug} --stage=review`',
			'                它一次跑完 8 项：符号 / 事实 / 质感 / 结构 / 内容质检 / 选题对齐 / 违禁词 / 技能分流。',
			'                **硬闸门**（符号/事实/结构/技能）不过就停下改；',
			'                **软提示**（质感/内容质检/选题对齐/违禁词）逐条看，该改就改，不改要给出理由。',
			'                其中「选题对齐」查文章有没有用上选题设计的读者三问——',
			'                报「未落地」的项，要么改文章落地，要么明确说明为什么不采用。选题白设计了才是真浪费。',
			'                再用 aws-wechat-article-review 审稿，回写 review_issues。',
			'   · reviewed   定稿+排版：**跑 `python dsh-workbench/tools/finalize.py drafts/{日期}-{slug}`**',
			'                排完再跑 `python dsh-workbench/tools/check-all.py drafts/{日期}-{slug} --stage=layout`',
			'                （符号必须查 article.html——只查 draft.md 等于没查；外加图位数量与均匀性）',
			'                （它一条命令做完：引号修正 → strip-citations → 插图片 → 排版 → 符号校验；',
			'                 失败会停下。**不要手工分步**——手工漏过「插图片」这一步，会导致排版产物全是裂图）',
			'                **图还没生成时**：加 `--allow-placeholder` 只出排版预览。',
			'                此时产物里是 `<img src="placeholder">`，**不可发布**（finalize 会拒绝）。',
			'   · formatted  插入图位：**只插图位，不生图。**',
			'                **⛔ 严禁在这一步调用 image-gen.py 或任何生图工具。**',
			'                配图已改为用户手工发起（文章定稿后才配），不属于自动流程。',
			'                这一步只做三件事：',
			'                  a) 按公式算该插几张：clamp(ceil(正文汉字数/500), 1, 5)',
			'                  b) 插入 `![类型：画面描述](placeholder)`，独占一行、前后各留空行；',
			'                     各图之间的字数间隔要**用字数等分算**，不要手工估（实测手工调必然不合格）',
			'                  c) 跑 `check-all.py <目录> --stage=layout` 确认图位数与均匀性',
			'                做完回写 status=formatted 然后**停下**，告诉用户：',
			'                「图位已插好，确认文章定稿后点『配图』按钮手工生成图片」。',
			'                不要自己往下推进到配图。',
			'   · illustrated 发布：**先不带 `--allow-placeholder` 重跑一次 finalize.py**，把 imgs/ 里的图',
			'                 真正插进 article.html（`illustrated` 这一步是必要的收口，不要跳过）；',
			'                 再调 aws-wechat-article-publish（需微信凭证；没有就停在草稿箱并说明）。',
			'                 ⚠️ publish.py 自身**不检查 placeholder**，防线在 finalize 里，所以必须先重跑。',
			'                 发布后用 add-publish 记一条（method=draft 表示只进草稿箱），状态回写 draftbox；真正群发才叫 published。',
			'3) 每步做完用 api set-draft 回写 status 与产出字段（title/digest/words/path/cover/imagesCount/reviewIssues）。',
			'4) 草稿的 viewpoint（作者观点）必须体现在文章立场与审稿判断里，不能丢。',
			'4b) **符号限制（所有写作技能都要遵守，与具体 skill 无关）**：结构靠 Markdown（加粗/列表/小标题/引用块）表达，不靠特殊标点。',
			'    · `——` 除金句行外禁用（金句行 `> 金句。 —— 出处` 里的 ` —— ` 是 write.py check 的机器语法，必须保留）；替代：拆句、改 `：`、或直接删。',
			'    · `「」` 禁用，改用中文双引号 “”；B 类技能若默认用「」也要改。',
			'    · `……` 尽量不用；`（）` 括注尽量少用；三项以上并列改 `- 一项` 分行。',
			'    · **ASCII 直引号 `"` 禁用**——排版工具会把直引号成对转成 `「」`，草稿里看不见、排版后才冒出来。写稿就要用中文双引号 `“”`。',
			'    · 原因：这些符号是 AI 味判定器的常见特征，会拉高判定浓度。',
			'    · 自检**必须跑脚本，不能靠数**：写完与**排完版**各跑一次',
			'      `python dsh-workbench/tools/check-symbols.py drafts/YYYYMMDD-slug`（它同时查 `article.html`，退出码 1 = 违规）。',
			'      违规则 `--fix` 修直引号并**重新排版**；只查 `draft.md` 等于没查。',
			'5) 简短回报：做了什么、下一步是什么。不要把全文贴进对话。'
		].join('\n')

		// 两次投递之间的冷却，避免连点造成多轮运行
		const TRIGGER_COOLDOWN_MS = 90 * 1000
		let lastTriggerAt = 0

		/** 每日批量生成选题的指令。点「生成今日选题」时投递给 Agent。 */
		function dailyTopicPrompt(dateStr) {
			return [
				'[工作台自动触发] 生成今日选题 · 每日批量（目标 20 个）。',
				'',
				'1) 先跑 `python dsh-workbench/tools/topic-pipeline.py --date ' + dateStr + '`',
				'   它会从当天素材里挑 10 条有爆文潜力的，各写一份加工指令到 `_tmp/topic-prompts/`。',
				'',
				'2) 逐份读 `_tmp/topic-prompts/material-*.md`，严格按里面的四步做：',
				'   ① 补全素材（标了「必做」的才搜）',
				'   ② 拆解素材（事实 / 缺口 / 公共命题）',
				'   ③ 定方向（指令指定的 2 个方向，必须给出不同解读）',
				'   ④ 出选题（带读者三问 + 四维评分）',
				'',
				'3) 每份产出的 JSON 存到 `_tmp/topic-results/material-NN.json`，然后：',
				'   `python dsh-workbench/tools/topic-pipeline.py --save --json _tmp/topic-results/material-NN.json`',
				'',
				'4) 全部跑完，回报：加工了几条素材、产出几个选题、几个达到优秀线。',
				'',
				'**硬要求**：',
				'· 同一素材的两个选题方向必须不同——读起来一个调性就是没做到差异化，重写。',
				'· 读者三问要具体到内心独白，不要「想了解」这种空话。',
				'· 不及格（情绪<3 且 受众<3）的选题不要提交。',
				'· 不要顺手建草稿——写作技能由用户在创作配置里手选。'
			].join('\n')
		}

		function analysisPrompt(focus) {
			if (!focus || !focus.id) return ANALYSIS_PROMPT
			return ANALYSIS_PROMPT +
				'\n\n【本轮指定】用户刚点的是 job #' + focus.id + '《' + (focus.title || '') + '》。' +
				'请先跑 `topic-pipeline.py --job ' + focus.id + '` 拿到加工指令，' +
				'优先完成这一条；若还有余量（本次上限 2 条），再按 id 倒序取其它 pending。'
		}

		// ── 创作骨架（本项目唯一流程真源）────────────────────────────
		// 为什么由本项目定义而不交给 SKILL.md：三个技能的步骤数不同，
		// 但阶段本质同一套；且「吃透素材→定角度→出骨架」在多数技能里是隐含的，
		// 不写成步骤 Agent 就会跳过。骨架稳定，skills 会换，所以是 skills 适配骨架。
		//
		// 每个阶段都要求回写产物，不允许「一口气吐全文」——那样无法验证是否真的走了流程。
		// ── 小标题规范（本项目唯一口径，优先级高于任何 SKILL.md）─────────
		// 为什么由项目定而不交给技能：实测 20 篇草稿发现，格式随技能变化——
		// 卡兹克明令不加小标题，娱乐套件明令用「一、二、三」序号。
		// 序号零信息量、是纸媒习惯，公众号读者扫标题时拿不到任何东西。
		//
		// 判据不是风格，是**读者要不要跳读**。小标题唯一的作用是帮读者定位。
		const HEADING_RULES = {
			// 该不该加：按顺序判断，命中即停。
			// 2026-11-07 修：原来的「1000-2500 字看板块」是个模糊判据，
			// 实测 aws 版(1017字4个) 和卡兹克版(1469字0个) 都落进这个区间，
			// 一个加了一个没加，两边都能自称合规。改成可数的段落数。
			when: [
				'① 数正文段落：超过 25 段就必须加（段落多说明信息密度高，读者需要定位）。',
				'② 段落 ≤ 25 但正文有 3 个以上彼此独立的板块，也要加。',
				'③ 板块少于 2 个，不加。',
				'④ 全文 < 1000 字一律不加（太短，加了显碎）。',
				'⑤ 判完之后再看：加完每节不足 300 字，说明切太碎，合并后按实际数量加。',
			],
			// 该怎么写：**前提是先判定为「要加」**。
			// 2026-11-08 改：原来这里直接写「数量 3-5 个」，而 khazix-writer 明令禁小标题。
			// 两条同时出现在 prompt 里，Agent 每次要现场裁决谁优先。
			// 改成条件式后：先判要不要加（按上面的 when 规则），
			// 判为不加就一个都不要，判为要加才有下面的数量要求。
			how: [
				'（以下只在判定为「要加」时适用。判为不加时，一个都不要加。）',
				'数量 3-5 个。少于 3 个说明本不该加；多于 5 个说明该合并板块。',
				'每条 ≤ 15 字，手机一行放得下。',
				'给信息不给结论：说这段讲什么，不说所以怎样。',
				'不用「一、二、三」「第一、第二」这类序号，序号不承载信息。',
				'只用 H2，不用 H3，不用分割线。',
			],
			examples: {
				good: ['同一个晚上的另一场球', '缺口在哪', '一个家庭拿走两块金牌', '她带着两块金牌走进决赛'],
				bad: ['一', '二', '第三章', '日本队已经追上中国队了（提前剧透结论）',
				      '从兄妹两人的不同处境看中日乒乓对抗结构的变化（超 15 字）'],
			},
		}

		/** 把 HEADING_RULES 渲染成指令文本。 */
		function headingRulesText() {
			return '【小标题规范 · 优先级高于任何 SKILL.md】\n' +
				'小标题的唯一作用是帮读者定位，所以判据是「读者要不要跳读」，不是文风。\n' +
				'**先判要不要加，再谈加几个。判为不加就一个都不加**（技能明令禁小标题时同样不加）。\n\n' +
				'**什么时候加**（按顺序判断，命中即停）\n' +
				HEADING_RULES.when.map((x) => '  ' + x).join('\n') + '\n\n' +
				'**加的话怎么写**\n' +
				HEADING_RULES.how.map((x) => '  · ' + x).join('\n') + '\n\n' +
				'**好例子**：' + HEADING_RULES.examples.good.join('　') + '\n' +
				'**坏例子**：' + HEADING_RULES.examples.bad.join('　') + '\n\n' +
				'判定为「不加」时，板块之间用口语转场句衔接（如「说回来」「还有个事」），不要硬断。'
		}

		// ── 结构工程（教程 03 + 实践补充，2026-11-08）─────────────────────
		// 为什么放骨架不放风格：风格管语言层（句式/节奏/用词），结构管信息层
		// （先给什么、哪里留悬念、每段承担什么功能）。同一个结构用不同风格写
		// 出来完全不同，所以结构是跨风格通用的，塞进风格库会重复写。
		//
		// 教程核心：结构不是总分总/三段式模板，是对读者注意力的控制。
		// 注意力是一条有起伏的曲线，不是水平线。问题是「读者读到哪里」。
		const STRUCTURE_RULES = {
			// 三字诀：所有结构通用
			threeWords: {
				悬念: '让读者心里升起「然后呢」。可以是问题没答完、冲突没解决，不一定是悬疑。',
				推进: '不断给新信息，但留一半。',
				释放: '最后给一个值得的回馈，让读者读完很想转发。',
			},

			// 六种结构：前三种来自教程，后三种来自实践
			types: [
				{
					key: 'story', name: '故事→观点', fit: '有独家素材', mode: 'thesis',
					rule: '观点必须从故事中长出来，不能贴上去。否则是没观点的流水账。',
					nodes: ['具体场景（画面，不是概括）', '事情怎么发生的', '转折在哪', '从故事里长出的观点', '回到故事收束'],
				},
				{
					key: 'problem', name: '问题→拆解答案', fit: '认知类 / 方法类', mode: 'thesis',
					rule: '问读者关心的真问题，答案留到最后。前面不能提前给答案。',
					nodes: ['抛出一个真问题', '为什么这个问题值得问', '一层层拆解', '答案（留到最后）', '这个答案意味着什么'],
				},
				{
					key: 'counter', name: '现象→反直觉判断', fit: '观点类 / 评论类', mode: 'thesis',
					rule: '反直觉那一步是全文爆点，也是转发率的主要来源。',
					nodes: ['描述一个习以为常的现象', '多数人怎么理解它', '反直觉的那一面（爆点）', '为什么会这样', '给出判断'],
				},
				{
					key: 'list', name: '逐条清单→归纳', fit: '政策 / 办事 / 避坑', mode: 'info',
					rule: '每条独立可查，读者要能跳着找自己那条。最后必须归纳，不能只是罗列。',
					nodes: ['先说清楚发生了什么', '第 1 件事（独立完整）', '第 2 件事…（并列，不重复）', '归纳：这些条目连起来说明什么'],
				},
				{
					key: 'timeline', name: '时间线→落点', fit: '因果链 / 变迁', mode: 'info',
					rule: '每个时间点必须是新事实，不能是同一个判断换个说法。',
					nodes: ['起点（某年某月）', '中间发生了什么', '转折点在哪', '现在的位置', '落点'],
				},
				{
					key: 'contrast', name: '对比→分栏', fit: '两个对象 / 两种立场', mode: 'thesis',
					rule: '靠差异说话，不靠形容词。差异要具体到可核对的事实。',
					nodes: ['A 面是什么', 'B 面是什么', '差异到底在哪', '为什么会有这个差异', '谁该关心这个差异'],
				},
			],

			// 开头三秒：拼的是信息效率，不是文采
			opening: {
				goal: '在最短时间内让读者明确：读下去对我有好处。',
				methods: ['具体场景开场（一个可见画面，比「近年来」强一百倍）',
				          '反常识判断开场（第一句抛跟主流相反的观念）',
				          '真问题开场（精准踩中读者处境）'],
				ban: '开头 100 字内不许出现正确的废话：众所周知、近年来、随着、在当今、不可否认。',
			},

			// 中段密度：读者不是来听你铺垫的，是来获取信息的
			middle: {
				standard: '删掉任何一句话，都不影响读者理解的，就删。',
				actions: ['每段只承担一个功能', '一段不塞三件事', '删掉所有没有信息量的过渡句'],
			},

			// 结尾：不总结全文，制造一个动作
			ending: {
				ban: '不总结全文（再总结一遍是零信息增量）。禁用：总之、综上、所以说、总结一下。',
				goal: '任务是制造一个动作，不是求转发。',
				directions: ['情绪收束（让读者心里咯噔一下）',
				             '值得回味的观点（合上文章还会再想两秒）',
				             '天然可转发的点（一句替读者说出心里话的话）'],
			},
		}

		/** 把结构规范渲染成指令文本。 */
		function structureRulesText(picked) {
			const T = STRUCTURE_RULES
			const lines = []
			lines.push('【结构工程 · 优先级高于任何 SKILL.md】')
			lines.push('结构不是总分总/三段式模板，是对读者注意力的控制。')
			lines.push('读者的注意力是一条有起伏的曲线，不是水平线。问题是「读者读到哪里」。')
			lines.push('')
			// ── 论点门（2026-11-10 加）──
			// 选结构之前先问「这篇有没有主张」。这一步以前没有，所以会出现
			// 「用时间线结构写一个本该有观点的选题」——结构名对了，内容性质错了。
			lines.push('**⛔ 选结构之前先过这一关：这篇有主张吗？**')
			lines.push('  · 创作配置里有【主论点】→ 只能选【论点型】结构。')
			lines.push('    每一节都要能回答「这一节跟主论点什么关系」，答不上就删。')
			lines.push('  · 没有【主论点】→ 只能选【资讯型】结构，')
			lines.push('    并且必须在开头就说明这是一篇整理（不是观点），否则读者读完会觉得「不知道你想说什么」。')
			lines.push('  · **有主论点却选资讯型结构 = 结构不匹配，必须改。**')
			lines.push('    实测反例：立冬那篇有观点可用，却选了「时间线→落点」，')
			lines.push('    写成 10 个话题并列的资讯稿，1316 字没有方向。')
			lines.push('')
			lines.push('**三字诀（所有结构通用）**')
			Object.keys(T.threeWords).forEach((k) => {
				lines.push('  · ' + k + ' —— ' + T.threeWords[k])
			})
			lines.push('')
			lines.push('**六种结构，按题材选一种**')
			T.types.forEach((t) => {
				const mark = (picked && t.key === picked) ? '　← 本篇选它' : ''
				const modeTag = t.mode === 'thesis' ? '【论点型】' : '【资讯型】'
				lines.push('  · ' + modeTag + ' **' + t.name + '**（适合：' + t.fit + '）' + mark)
				lines.push('      ' + t.rule)
				lines.push('      节点：' + t.nodes.join(' → '))
			})
			lines.push('')
			lines.push('**开头三秒**：' + T.opening.goal)
			T.opening.methods.forEach((m) => lines.push('  · ' + m))
			lines.push('  ⛔ ' + T.opening.ban)
			lines.push('')
			lines.push('**中段密度**：' + T.middle.standard)
			T.middle.actions.forEach((m) => lines.push('  · ' + m))
			lines.push('')
			lines.push('**结尾**：' + T.ending.goal)
			T.ending.directions.forEach((m) => lines.push('  · ' + m))
			lines.push('  ⛔ ' + T.ending.ban)
			return lines.join('\n')
		}

		const SKELETON_STAGES = [
			{ k: 'load', name: '① 准备', need: '主题 / 核心角度 / 素材 / 风格',
			  do: '读齐创作配置。缺什么就明说缺什么，不要自己补。' },
			{ k: 'digest', name: '② 吃透素材', need: '参考素材',
			  do: '把素材里的事实拆出来：时间、地点、数字、原话、动作、因果。逐条列，不许概括。素材超 300 字也要拆，因为后面每一步都要引用它们。' },
			{ k: 'angle', name: '③ 定论点', need: '②拆出的事实 + 创作配置里的【主论点】',
			  do: '先把**主论点**定下来，再用两句话自检。\n'
			      + '**主论点**：一句判断句，说清这篇文章要让读者记住什么。三个条件——'
			      + '能被反驳（有人会说不对）、指向动作或立场（读者知道下一步怎么办或怎么看）、不含「值得/应该/很重要」这类空泛词。\n'
			      + '**两句话自检**：① 主论点是什么？② 读者为什么点开（最反常的事实或最戳的处境）？两句话不能相同。\n'
			      + '**配置里已经有【主论点】就直接用，不要另起一个。**'
			      + '如果你觉得那个主论点不行，说出来让用户确认，不要默默换掉。' },
			{ k: 'outline', name: '④ 出骨架', need: '③的两句话',
			  do: '**先选结构类型**（六种之一，按题材定，见 STRUCTURE_RULES），再按该结构的 nodes 出推进节点。'
			      + '**每个节点标上预计字数**，加起来要等于目标字数（允许 ±10%）。'
			      + '这不是形式——不分配字数，第⑤步就会写到「意思够了」就停，成品必然偏短。'
			      + '每个节点标注：这一段承担什么功能、用②里哪条事实支撑、在哪里留悬念、在哪里释放。\n'
			      + '**还必须多标一项：这一节为主论点做了什么**——支撑 / 反驳 / 举例，三者之一。'
			      + '标不出来的，就是过渡节或跑题节，删掉或合并到相邻节点。'
			      + '这一项是可执行的检票口：骨架交上来时，每个节点后面都得有一个词。'
			      + '**同时判定要不要小标题**（见 HEADING_RULES）。**先交骨架等确认**，用户已填骨架时直接沿用。' },
			{ k: 'write', name: '⑤ 写正文', need: '④的骨架 + 风格',
			  do: '按骨架逐段写。风格决定怎么写（句式/节奏/标点/禁忌），骨架决定写什么，两者冲突时以骨架的信息为准、以风格的表达为准。'
			      + '\n**字数硬要求**：成品必须达到目标字数的 ±10% 以内。'
			      + '写完后数一遍，不够就展开——展开靠「把②里的事实讲透」（补细节、补因果、补对照），'
			      + '不靠灌水（不加形容词、不加评论、不加「值得注意的是」这类过渡句）。'
			      + '字数超了也要收——按中段密度那条删。' },
			{ k: 'check', name: '⑥ 自检', need: '⑤的全文',
			  do: '逐条对：每个实词能不能在②里指出出处（编造=不合格）；'
			      + '**结构是否合规**（开头 100 字有无废话、中段有无可删的过渡句、结尾是否在总结全文、悬念推进释放三字诀走没走完）；'
			      + '风格禁忌有没有犯；小标题是否符合 HEADING_RULES；禁用标点与加粗密度。'
			      // ── 内容质量三问（2026-11-08 加）──
			      // 前三项脚本能查，以下三项只能语义判断。加进来是因为实测发现：
			      // 脚本全过、结构合规的稿子，内容上照样有硬伤（见 v11 复盘）。
			      + '\n\n**另外三项必须自己答，答不上就改：**\n'
			      + '① **选题三问落地了吗**：选题里的「读者为什么点 / 读完得到什么 / 为什么会转发」，'
			      + '这三条在正文里能不能逐条找到对应的段落？'
			      + '特别注意「读者为什么点」——如果它写的是第一人称处境（如「我妈天天转发长寿文章」），'
			      + '正文里就该有「我」的位置。全文没有第一人称，说明这篇站在了分析者的位置上，不是读者的位置上，不合格。\n'
			      + '② **最痛处收住了吗**：把全文最扎人的那句话找出来，看它后面紧跟着的是什么。'
			      + '如果紧接着是「这不是要苛责」「不必过度解读」「客观来说」这类话，就是把读者刚升起的感受按下去了，删掉那句解释。'
			      + '克制不是把话说完，是讲到那里就停。\n'
			      + '③ **金句指向具体东西吗**：全文最好的一句，检查它有没有指向一个可指认的对象。'
			      + '「就是这件事本身」「说到底还是那个道理」这类是空转，按金句三步法重打磨：'
			      + '先写一句废话 → 加一个具体参照系 → 压缩到只留骨架。\n'
			      // ── 论点一致性（2026-11-10 加）──
			      // 立冬那篇的教训：脚本全过、结构合规，但一篇里塞了三个论点。
			      + '④ **每一节都在为主论点服务吗**（最重要的一项）：'
			      + '把主论点原句抄一遍，然后逐节问「这一节是在支撑它、反驳它、还是举例说明它」。'
			      + '三者都不是的——只是补充背景、只是介绍另一件事、只是把「报道没说的部分」讲一遍——'
			      + '要么删，要么压成一句话带过。\n'
			      + '   **特别检查两条**：\n'
			      + '   · 全文只能有**一个**主论点。不许中途换题，不许在结尾另起一个新观点。'
			      + '结尾必须回扣主论点，而不是给出一句新的判断。\n'
			      + '   · **素材缺口相关的内容不得单独成节，也不得单独成段**，总量不超过全文 15%。'
			      + '缺口是用来守住事实边界的（「报道里没提」），不是用来撑篇幅的。'
			      + '实测反例：立冬那篇把「报道没区分人群」这个缺口写成了最大的一节，占全文 40%。' },
			{ k: 'deliver', name: '⑦ 交付', need: '⑥通过的稿',
			  do: '落盘 draft.md，回写 status。把②里的「素材缺口」一并报给用户，不要隐瞒。' },
		]

		/** 把骨架渲染成指令文本。传了 skill 就标出哪几步该技能已自带。 */
		function skeletonText(mode, skillName) {
			// 该技能的 covers：没登记的技能当作什么都不自带，全靠骨架
			const sk = WRITING_SKILLS.find((x) => x.name === skillName)
			const covers = (sk && sk.covers) || []
			const lines = SKELETON_STAGES.map((s) => {
				const own = covers.indexOf(s.k) >= 0
				return s.name + (own ? '（技能自带，按技能的做法走）' : '（**必须补上，技能没这步**）') +
					'\n    需要：' + s.need + '\n    → ' + s.do
			})
			if (mode === 'write') {
				return '【创作骨架 · 必须逐阶段走完，不许跳步】\n' +
					'以下七步是本项目的固定流程，优先级高于任何 SKILL.md 里自带的步骤划分。\n' +
					'技能只负责第⑤步的写法，不负责流程。\n\n' + lines.join('\n\n') +
					'\n\n**执行要求**：\n' +
					'1. 不要一口气吐全文。第②③④步的产物要先给用户看。\n' +
					'2. 第④步给出骨架后，等用户确认再写正文（用户已填骨架则直接沿用）。\n' +
					'3. 第②步发现素材不足时，**列缺口**，不许用「据了解」「有分析指出」这类话补空。\n' +
					'4. 第⑥步自检不通过就改，改完再交。\n\n' +
				headingRulesText()
			}
			return lines.join('\n\n')
		}

		function writingPrompt(focus) {
			if (!focus || !focus.id) return WRITING_PROMPT
			let t = WRITING_PROMPT + '\n\n【本轮指定】draft #' + focus.id + '《' + (focus.title || '') + '》'
			if (focus.from) {
				t += '，当前阶段 ' + (DRAFT_LABEL[focus.from] || focus.from) +
					'，请推进到下一阶段' + (nextStage(focus.from) ? '（' + DRAFT_LABEL[nextStage(focus.from)] + '）' : '')
			}
			t += '。用 api list-drafts / set-draft 操作，完成后回写。'
			// topic_id 必须随指令带过去：之前一直是 None，导致 check-topic-align
			// 每次都报「数据层没有关联选题，跳过」——最重要的一道检查从没跑过。
			if (focus.topicId) {
				t += '\n**关联选题：topic #' + focus.topicId + '——set-draft 回写时必须带 topicId，不能留空。**'
			}

			// 创作配置：用户在「创作配置」里填的东西必须原样送达 Agent。
			// 这些内容也存在 drafts 表里（theme/materials/requirement/config_json），
			// 但 Agent 收到的是对话指令，不写进指令它就会漏看。
			const cfg = []
			if (focus.skill) {
				cfg.push('**写作技能（用户手选，不要再按赛道换）**：' + focus.skill +
					(focus.skillClass ? '（' + focus.skillClass + ' 类）' : ''))
			}
			if (focus.theme) cfg.push('**主题**：' + focus.theme)
			if (focus.words) cfg.push('**目标字数**：约 ' + focus.words + ' 字')
			// 「核心角度」取代原来的「用户要求（观点）」：后者措辞太泛，
			// 用户填的多是「这事挺有意思」，够不上骨架第③步要的可验证命题。
			// 主论点排在最前面：它是全文唯一的方向标，比核心角度更硬。
			if (focus.thesis) {
				cfg.push('**主论点（全文唯一的方向标）**：' + focus.thesis)
			}
			if (focus.requirement) {
				cfg.push('**核心角度（骨架第③步的输入，文章立场必须体现它）**：' + focus.requirement)
			}
			if (focus.skeleton) {
				cfg.push('**文章骨架（用户已填，直接沿用，跳过生成）**：\n' + focus.skeleton)
			}
			if (focus.materials) {
				cfg.push('**参考素材**（用户粘贴的正文，是最主要的事实来源）：\n' + focus.materials)
			}
			if (cfg.length) {
				t += '\n\n【创作配置】\n' + cfg.join('\n')
				t += '\n\n若库里 theme/materials/requirement 与本段不一致，以本段为准；' +
					'缺素材时不要凭空写事实，宁可标出缺什么。'

				// ── 事实边界（2026-11-10 加）──
				// 原来只说「缺素材时不要凭空写事实」，太笼统。
				// 实测：写第一人称时会顺口编出「七点零四」「六点五十起床」这类时刻，
				// 既过不了 check-facts，读者也会当成真事。
				// 规则要具体到「能用什么、不能用什么」，否则每篇都要重新纠结一次。
				t += '\n\n【事实边界 · 第一人称怎么写才不违规】\n' +
					'· 素材里没有的数字、时刻、金额、人名、机构名，一律不许写——**包括作者自述里的**。\n' +
					'· 第一人称段落要具体，但**具体靠动作和物件，不靠编造的数字**：\n' +
					'   ✓ 「按了三次闹钟」「摸过手机」「天没亮」「窗外是灰的」——有画面，且不是事实断言\n' +
					'   ✗ 「七点零四」「六点五十起床」「八点十分到公司」——素材没有这些数，写了就是编\n' +
					'· 需要写具体时刻时，**回素材里找**；素材没有就写「报道没提」。\n' +
					'· 判据：这个数字删掉，读者还能看懂画面吗？能，就别写它。'
			}

			// ── 主论点硬要求（2026-11-10 加）──
			// 光给一个字段不够，必须写明它怎么约束全文，否则模型会当成「参考」。
			if (focus.thesis) {
				t += '\n\n【主论点 · 硬要求】\n' +
					'· 全文**只能有一个**主论点，就是上面那句。不许中途换题，不许在结尾另起一个新观点。\n' +
					'· **每一节**都要能回答「这一节为主论点做了什么」——支撑、反驳、举例，三者之一。答不上就删。\n' +
					'· 结尾必须**回扣**这句主论点，不是给出一句新的判断。\n' +
					'· 素材缺口相关的内容不得单独成节，总量 ≤ 全文 15%。\n' +
					'· 自检时把主论点原句抄一遍，对着全文逐节核。'
			}

			// ── 创作骨架：七阶段流程，优先级高于技能自带步骤 ──
			// 只强调该技能没自带的阶段，避免把技能本来做对的事又覆盖一遍。
			t += '\n\n' + skeletonText('write', focus.skill)

			// ── 结构工程：六种结构 + 三字诀，同样优先级高于技能 ──
			// 教程 03 的核心：结构不是格式，是对注意力的控制。
			t += '\n\n' + structureRulesText(focus.structureType)

			// ── 创作风格：整份 Markdown 原样送达 ──
			// 这是风格真正生效的唯一通道。以前只把一个短代号存进 DB 却没进指令，
			// 所以界面上选了风格也不影响出稿——现在把全文带上。
			//
			// 为什么放在【创作配置】之后单独一段、且用更强的措辞：
			// 风格是一份完整的写作提示词，它可能和 skill 的默认规则冲突
			// （比如 skill 要求加小标题，风格明令禁止）。必须让 Agent 知道
			// 「这份风格对本篇有最高优先级」，否则它会被 skill 的硬规则盖掉。
			if (focus.styleBody) {
				t += '\n\n【写作风格 · 最高优先级】\n' +
					'以下是用户为本篇选定的写作风格（' + (focus.styleName || '自定义') +
					'，' + (focus.styleCode || '') + '）。请**严格执行**：\n' +
					'- 它描述的句式、节奏、用词、标点、结构、禁忌，优先级高于写作技能的默认风格规则；\n' +
					'- 若风格与技能规则冲突，**以风格为准**（例：风格禁用小标题，就不加小标题）；\n' +
					'- 「禁忌清单」是硬性的，出现即视为不合格；\n' +
					'- 「范文摘录」请当作语气锚点读，不要照抄内容。\n\n' +
					'--- 风格正文开始 ---\n' + focus.styleBody + '\n--- 风格正文结束 ---'
			}
			return t
		}

		// 投递目标的会话标题。用户为公众号建了专用会话，直接按名字锚定，
		// 不再靠「最近更新」——那个规则在用户同时开多个会话时必然投错。
		const TARGET_SESSION_TITLE = 'Agent-公众号'

		/** 从会话对象里取标题，字段名兼容几种常见写法。 */
		function sessionTitle(s) {
			if (!s) return ''
			return String(s.title || s.name || s.label || s.subject || '').trim()
		}

		async function triggerAgent(remote, log, text, preferredTitle) {
			if (!remote || !remote.session || typeof remote.session.list !== 'function') {
				throw new Error('remote.session 不可用')
			}
			if (Date.now() - lastTriggerAt < TRIGGER_COOLDOWN_MS) {
				throw new Error('COOLDOWN')
			}
			const listed = await remote.session.list({})
			if (listed && listed.ok === false) {
				throw new Error('session.list 失败：' + JSON.stringify(listed.error))
			}
			const items = ((listed && listed.value && listed.value.items) || [])
				.filter((s) => s && s.origin !== 'subagent' && s.blank !== true)

			// 优先序：调用方显式指定 > 用户在界面上手选（localStorage）> 默认 Agent-公众号
			let want = String(preferredTitle || '').trim()
			if (!want) {
				try {
					const saved = window.localStorage.getItem('dsh-workbench:targetSession')
					if (saved) {
						const o = JSON.parse(saved)
						if (o && o.title) want = String(o.title).trim()
					}
				} catch (err) { /* localStorage 不可用时忽略 */ }
			}
			if (!want) want = TARGET_SESSION_TITLE
			let target = null
			let how = ''

			// ① 标题精确匹配
			if (want) {
				target = items.find((s) => sessionTitle(s) === want) || null
				if (target) how = '按标题精确匹配'
			}
			// ② 标题包含匹配（用户可能加了后缀或前缀）
			if (!target && want) {
				target = items.find((s) => sessionTitle(s).indexOf(want) >= 0) || null
				if (target) how = '按标题包含匹配'
			}
			// ③ 退回最近更新（保持旧行为，不硬失败）
			if (!target) {
				const sorted = items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
				target = sorted[0] || null
				if (target) how = '退回最近更新（没找到名为「' + want + '」的会话）'
			}
			if (!target) throw new Error('找不到可用会话')
			if (log) log('投递目标：' + (sessionTitle(target) || String(target.sessionId).slice(0, 8)) + '　（' + how + '）')

			const requestId = 'wb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
			let tz
			try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch (err) { tz = undefined }
			const sent = await remote.session.prompt({
				requestId,
				sessionId: target.sessionId,
				mode: 'queue',                       // 排队，不打断你正在说的话
				content: [{ type: 'text', text: text }],
				clientTimeZone: tz
			})
			if (sent && sent.ok === false) {
				throw new Error('session.prompt 失败：' + JSON.stringify(sent.error))
			}
			lastTriggerAt = Date.now()
			if (log) log('已投递分析指令到会话 ' + String(target.sessionId).slice(0, 8) + '…')
			return sent && sent.value
		}

		// ── 每日热榜的本地归档（7 天滚动） ──
		const MAT_STORE_KEY = 'dsh-workbench:gzh:materials'
		function loadMaterialArchive() {
			const embedded = MATERIALS || { byDate: {}, dates: [], platforms: [] }
			let local = null
			try {
				const raw = window.localStorage.getItem(MAT_STORE_KEY)
				local = raw ? JSON.parse(raw) : null
			} catch (err) { local = null }
			if (!local || !local.byDate || (embedded.fetchedAt || '') > (local.fetchedAt || '')) {
				saveMaterialArchive(embedded)
				return embedded
			}
			return local
		}
		function saveMaterialArchive(arch) {
			try { window.localStorage.setItem(MAT_STORE_KEY, JSON.stringify(arch)) } catch (err) { /* 忽略 */ }
		}

		// modules 的顺序就是 tab 顺序，**modules[0] 是默认打开的那个**。
		// 技能包排在最后：它是查阅用的（"这一步该用什么"），不是日常入口；
		// 日常主线是 素材 → 选题 → 创作 → 发布。
		const APPS = [
			{ key: 'skills', label: '技能库', glyph: '技', kind: 'registry', modules: ['技能库'] },
			{ key: 'gzh', label: '公众号工作台', glyph: '公', pack: 'gzh',
			  // 每日热榜和爆文库是**两个平级模块**，不是「素材库」里的两个页签：
			  // 热榜是当天的实时风向（天天变、7 个平台），爆文库是跨平台的存量爆款
			  // （按日期回溯、带封面和互动数）。混在一个页里用户找不到爆文库。
			  modules: ['每日热榜', '爆文库', '选题库', '创作库', '发布管理', '风格库', '技能包'] },
			// 画廊的四个库**各自是独立模块**，不合并成一个带子切换的页：
			// 它们是四种不同的资产，合并会让人以为只做了第一个（第一版就踩了这个）。
			// 注：角色/道具/场景是「资产库」不是画廊，见下方 ASSET_MOD。
			{ key: 'image', label: '生图工作台', glyph: '图', pack: 'image',
			  modules: ['漫图创作', '风格库', '图型库', '主色调', '角色资产库', '我的创作', '技能包'] }
		]

		const S = {
			page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: '13px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif', color: 'var(--dsw-alias-label-primary)', position: 'relative' },
			tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center', padding: '12px 22px 10px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', flex: '0 0 auto' },
			tab: { padding: '5px 12px', borderRadius: '999px', cursor: 'pointer', font: 'inherit', background: 'transparent' },
			tabOn: { border: '1px solid var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
			tabOff: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', color: 'var(--dsw-alias-label-secondary)' },
			head: { padding: '16px 22px 8px', flex: '0 0 auto' },
			h1: { margin: 0, fontSize: '19px', fontWeight: 650, letterSpacing: '-0.01em' },
			sub: { margin: '6px 0 0', fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)' },
			search: { marginTop: '11px', width: '100%', maxWidth: '420px', boxSizing: 'border-box', padding: '8px 12px', borderRadius: '9px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', outline: 'none' },
			body: { flex: '1 1 auto', overflow: 'auto', padding: '4px 22px 26px' },
			stageHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', margin: '18px 0 4px' },
			stageName: { fontSize: '13px', fontWeight: 650 },
			stageMode: { fontSize: '10.5px', padding: '1px 7px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', color: 'var(--dsw-alias-label-secondary)' },
			stageNote: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', margin: '0 0 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
			// 卡片看板底：只在**卡片网格**下面垫一层浅灰，不动整页底色。
			// 整页灰会把工具栏、表头、留白一起变脏，实测观感偏重；
			// 垫在网格上则白卡片自然浮起，且留白仍是干净的。
			// 用 label-primary 百分比混色而非写死灰色，深色主题会自动转成略微提亮。
			grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(228px, 1fr))', gap: '12px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)', borderRadius: '14px', padding: '14px' },
			card: { textAlign: 'left', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', padding: '12px 13px', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '6px', minHeight: '128px' },
			glyph: { width: '26px', height: '26px', borderRadius: '7px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700, background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)' },
			cardTitle: { fontSize: '14.5px', fontWeight: 650 },
			cardId: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))', wordBreak: 'break-all' },
			cardDesc: { fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
			badge: { alignSelf: 'flex-start', marginTop: 'auto', fontSize: '10.5px', padding: '1px 7px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', color: 'var(--dsw-alias-label-secondary)' },
			empty: { padding: '46px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' },
			drawer: { position: 'absolute', top: 0, right: 0, bottom: 0, width: '430px', maxWidth: '82%', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-layer-1)', borderLeft: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', boxShadow: '-12px 0 32px rgba(0,0,0,.12)' },
			drawerHead: { padding: '16px 18px 12px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', flex: '0 0 auto' },
			drawerBody: { flex: '1 1 auto', overflow: 'auto', padding: '14px 18px 22px', display: 'flex', flexDirection: 'column', gap: '14px' },
			block: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', padding: '12px' },
			blockTitle: { fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--dsw-alias-label-secondary)' },
			textarea: { width: '100%', boxSizing: 'border-box', minHeight: '76px', resize: 'vertical', padding: '8px 10px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', font: 'inherit', outline: 'none' },
			btn: { marginTop: '8px', padding: '6px 14px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer' },
			doc: { fontSize: '12.5px', lineHeight: '1.75', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)' },
			close: { position: 'absolute', top: '12px', right: '14px', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '16px', cursor: 'pointer', padding: '4px 8px' },
			placeholder: { border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '18px', color: 'var(--dsw-alias-label-secondary)' },
			err: { border: '1px solid #b42318', borderRadius: '10px', padding: '10px 12px', color: '#b42318', fontSize: '12.5px', marginTop: '10px', whiteSpace: 'pre-wrap' },
			// 线条统一加深：border-l1 太淡，卡片与表格边界看不出层次。
			// 用 label-primary 的 20% 混色 —— 浅色主题下约等于 #ccc，深色主题下自动变成浅灰线，
			// 同一个值两套主题都成立。改深浅只需动这一个百分比。
			wrap: { marginTop: '12px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', overflow: 'hidden', overflowX: 'auto' },
			table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
			th: { textAlign: 'left', padding: '9px 12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', whiteSpace: 'nowrap' },
			td: { padding: '9px 12px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', verticalAlign: 'top' },
			num: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)', width: '46px' },
			mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
			tag: { fontSize: '11px', padding: '1px 7px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
			mini: { padding: '3px 10px', borderRadius: '7px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' },
			miniOff: { opacity: .5, cursor: 'default' },
			toast: { position: 'absolute', left: '50%', bottom: '24px', transform: 'translateX(-50%)', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)', padding: '8px 16px', borderRadius: '999px', fontSize: '12.5px', whiteSpace: 'nowrap' }
		}

		function Icon(app) {
			return function Glyph(props) {
				const size = (props && props.size) || 18
				return h('span', {
					style: {
						width: size, height: size, display: 'inline-flex', alignItems: 'center',
						justifyContent: 'center', fontSize: Math.round(size * 0.7), fontWeight: 600,
						opacity: props && props.active ? 1 : 0.78
					}
				}, app.glyph)
			}
		}

		function copyText(text, cb) {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(cb, cb)
					return
				}
			} catch (err) { /* 兜底 */ }
			try {
				const ta = document.createElement('textarea')
				ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'
				document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
			} catch (err) { /* 忽略 */ }
			cb()
		}

		// 复制富文本：同时写 text/html 与 text/plain。
		// 公众号编辑器不解析 markdown，只有 text/html 才能粘出带格式的正文。
		// ClipboardItem 需要安全上下文（http://127.0.0.1 与 https 都算）。
		// 关键：**绝不静默复制空内容**——失败要如实回报，否则用户以为复制成功了。
		function copyRich(html, text, onOk, onFail) {
			const rich = html || ''
			const plain = text || rich
			if (!plain) {
				if (onFail) onFail('没有可复制的内容')
				return
			}
			const fallback = () => {
				copyText(plain, () => {
					if (onOk) onOk('富文本剪贴板不可用，已复制纯文本')
				})
			}
			try {
				if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
					const item = new window.ClipboardItem({
						'text/html': new Blob([rich || plain], { type: 'text/html' }),
						'text/plain': new Blob([plain], { type: 'text/plain' })
					})
					navigator.clipboard.write([item]).then(() => { if (onOk) onOk() }, fallback)
					return
				}
			} catch (err) { /* 走降级 */ }
			fallback()
		}

		// ── 顶层技能库（资产视图） ──
		// 回答「系统里装了什么、谁在用它」；不回答「这一步该用什么」——那是各工作台内的技能包。
		// 同一个技能可以被多个工作台引用：这里显示全部引用位置，改技能信息只需改磁盘上一次。
		function SkillLibrary() {
			const reg = SKILL_REGISTRY || { skills: [], packs: [] }
			const skills = reg.skills || []
			const [q, setQ] = React.useState('')
			const [only, setOnly] = React.useState('all')      // all | used | unused
			const [sel, setSel] = React.useState(null)
			const kw = q.trim().toLowerCase()
			const nUsed = skills.filter((s) => (s.usedBy || []).length > 0).length
			const visible = skills
				.filter((s) => only === 'all' ? true
					: only === 'used' ? (s.usedBy || []).length > 0 : (s.usedBy || []).length === 0)
				.filter((s) => !kw || s.name.toLowerCase().includes(kw)
					|| (s.title || '').toLowerCase().includes(kw)
					|| (s.desc || '').toLowerCase().includes(kw))
			const pill = { padding: '4px 11px', borderRadius: '999px', cursor: 'pointer', font: 'inherit', fontSize: '12.5px', background: 'transparent' }
			const M = {
				k: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' },
				v: { fontSize: '12.5px', lineHeight: '1.75', wordBreak: 'break-all' }
			}
			const chips = [
				['all', '全部 ' + skills.length],
				['used', '已挂流水线 ' + nUsed],
				['unused', '未挂 ' + (skills.length - nUsed)]
			]
			// 用数组装 children：深层 h() 链的尾部括号极易数错，数组形式不会。
			const chipRow = chips.map(([k, label]) => h('button', {
				key: k, type: 'button',
				style: Object.assign({}, pill, only === k ? S.tabOn : S.tabOff),
				onClick: () => setOnly(k)
			}, label))

			const rows = visible.map((s) => {
				const refs = (s.usedBy || []).length
					? h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } }, (s.usedBy || []).map((u, i) =>
						h('span', { key: i, style: S.tag },
							(u.packTitle || u.pack).replace('创作技能包', '') + ' · ' + u.stage)))
					: h('span', { style: S.mono }, '未挂流水线')
				return h('tr', { key: s.name }, [
					h('td', { style: S.td }, [
						h('div', { style: { fontWeight: 600 } }, s.title || s.name),
						h('div', { style: Object.assign({}, S.mono, { color: 'var(--dsw-alias-label-secondary)' }) },
							// 子技能标出归属。不标的话，handraw-style 那十几个子技能
							// 会和顶层技能混成一排，看不出「这是某个技能包的内部入口」。
							(s.parent ? s.parent + ' / ' : '') + s.name)
					]),
					h('td', { style: Object.assign({}, S.td, { maxWidth: '340px' }) }, s.desc || '—'),
					h('td', { style: S.td }, refs),
					h('td', { style: S.td }, [
						s.scripts ? h('span', { style: Object.assign({}, S.tag, { marginRight: '6px' }) }, '含脚本') : null,
						h('button', { style: S.mini, type: 'button', onClick: () => setSel(s) }, '详情')
					])
				])
			})

			const table = visible.length === 0
				? h('div', { style: S.placeholder }, '没有匹配的技能')
				: h('div', { style: S.wrap },
					h('table', { style: S.table }, [
						h('thead', null, h('tr', null, ['技能', '作用', '引用位置', '操作'].map((label) =>
							h('th', { key: label, style: S.th }, label)))),
						h('tbody', null, rows)
					]))

			const drawer = sel ? h('div', { style: S.drawer }, [
				h('button', { style: S.close, type: 'button', onClick: () => setSel(null), title: '关闭' }, '✕'),
				h('div', { style: S.drawerHead }, [
					h('h2', { style: { margin: 0, fontSize: '16.5px', fontWeight: 650 } }, sel.title || sel.name),
					h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
						h('span', { style: S.tag }, sel.name),
						sel.root ? h('span', { style: S.tag }, sel.root === 'global' ? '全局安装' : '项目级') : null,
						sel.scripts ? h('span', { style: S.tag }, '含脚本') : null
					])
				]),
				h('div', { style: S.drawerBody }, [
					h('div', { style: S.block }, [
						h('div', { style: S.blockTitle }, '作用'),
						h('div', { style: M.v }, sel.desc || '—')
					]),
					h('div', { style: S.block }, [
						h('div', { style: S.blockTitle }, '引用它的流水线'),
						(sel.usedBy || []).length
							? h('div', null, (sel.usedBy || []).map((u, i) =>
								h('div', { key: i, style: M.v }, '· ' + (u.packTitle || u.pack) + ' → ' + u.stage)))
							: h('div', { style: M.v }, '未挂任何流水线（通用工具，随时可用）')
					]),
					h('div', { style: S.block }, [
						h('div', { style: S.blockTitle }, '位置'),
						h('div', { style: Object.assign({}, M.v, S.mono) }, sel.path || '—')
					]),
					h('div', { style: S.block }, [
						h('div', { style: S.blockTitle }, '怎么调用'),
						h('div', { style: M.v }, '在输入框打 `/技能名` 调用；本工作台流水线里的技能，'
							+ '点工作台「技能包」对应卡片可复制调用指令。')
					])
				])
			]) : null

			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto', position: 'relative' } }, [
				h('div', { style: S.head }, [
					h('h1', { style: S.h1 }, '技能库'),
					h('p', { style: S.sub }, '系统已安装 ' + skills.length + ' 个技能。这是「资产视图」：'
						+ '看得到每个技能被哪些工作台的哪个阶段引用；同一个技能可被多个工作台共用。'
						+ '「这一步该用什么」到各工作台的「技能包」里看。'),
					h('div', { style: S.stageHead }, chipRow.concat([
						h('input', {
							style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '240px', marginLeft: 'auto' }),
							placeholder: '搜索技能名或作用…', value: q,
							onChange: (ev) => setQ(ev.target.value)
						})
					]))
				]),
				h('div', { style: S.body }, table),
				drawer
			])
		}

		// ── 技能包 ──
		function SkillPack(props) {
			const pack = SKILL_PACKS[props.pack] || { title: '技能包', stages: [], skills: [] }
			const [q, setQ] = React.useState('')
			const [sel, setSel] = React.useState(null)
			const [input, setInput] = React.useState('')
			const [toast, setToast] = React.useState('')

			if (!pack.skills || pack.skills.length === 0) {
				return h('div', { style: S.body },
					h('div', { style: S.head }, h('h1', { style: S.h1 }, pack.title || '技能包'),
						h('p', { style: S.sub }, '尚未配置。给这个工作台补技能时，在 tools/gen-catalog.py 的 STAGES 里加一组即可。')),
					h('div', { style: S.placeholder }, '（空）'))
			}
			const kw = q.trim().toLowerCase()
			const visible = pack.skills.filter((s) => !kw ||
				s.name.toLowerCase().includes(kw) ||
				(s.title || '').toLowerCase().includes(kw) ||
				(s.desc || '').toLowerCase().includes(kw))
			const stages = pack.stages
				.map((st) => ({ st, items: visible.filter((s) => s.stage === st.name) }))
				.filter((x) => x.items.length > 0)

			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
				h('div', { style: S.head },
					h('h1', { style: S.h1 }, pack.title),
					h('p', { style: S.sub }, '共 ' + pack.skills.length + ' 个技能，按流水线阶段分区。点卡片查看说明。'),
					h('input', { style: S.search, placeholder: '搜索技能名或描述…', value: q, onChange: (ev) => setQ(ev.target.value) })
				),
				h('div', { style: S.body },
					stages.length === 0
						? h('div', { style: S.empty }, '没有匹配「' + q + '」的技能')
						: stages.map((x) => h('div', { key: x.st.name },
							h('div', { style: S.stageHead },
								h('span', { style: S.stageName }, x.st.name),
								x.st.mode ? h('span', { style: S.stageMode }, x.st.mode) : null),
							x.st.note ? h('p', { style: S.stageNote }, x.st.note) : null,
							h('div', { style: S.grid }, x.items.map((s) => h('button', {
								key: s.name, type: 'button', style: S.card,
								onClick: () => { setSel(s); setInput('') }
							},
								h('span', { style: S.glyph }, (s.title || s.name).slice(0, 1)),
								h('span', { style: S.cardTitle }, s.title || s.name),
								h('span', { style: S.cardId }, s.name),
								h('span', { style: S.cardDesc }, s.desc || ''),
								s.scripts ? h('span', { style: S.badge }, '含脚本') : null
							)))
						))
				),
				sel ? h('div', { style: S.drawer },
					h('button', { style: S.close, type: 'button', onClick: () => setSel(null), title: '关闭' }, '✕'),
					h('div', { style: S.drawerHead },
						h('h2', { style: { margin: 0, fontSize: '16.5px', fontWeight: 650 } }, sel.title || sel.name),
						h('div', { style: Object.assign({}, S.cardId, { marginTop: '4px' }) }, sel.name),
						h('span', { style: Object.assign({}, S.badge, { marginTop: '8px' }) }, sel.stage || '')),
					h('div', { style: S.drawerBody },
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '运行'),
							h('textarea', {
								style: S.textarea, value: input, placeholder: '输入内容，例如主题 / 素材 / 要求…',
								onChange: (ev) => setInput(ev.target.value)
							}),
							h('button', {
								style: S.btn, type: 'button',
								onClick: () => copyText('/' + sel.name + (input.trim() ? ' ' + input.trim() : ''),
									() => { setToast('已复制 /' + sel.name + '，粘贴到输入框发送即可运行'); window.setTimeout(() => setToast(''), 2200) })
							}, '复制调用指令'),
							h('div', { style: Object.assign({}, S.doc, { marginTop: '8px', fontSize: '11.5px' }) },
								'复制后到输入框粘贴发送 —— DSH 里 /技能名 是官方的 skill 调用路径。')),
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '说明'),
							h('div', { style: S.doc }, sel.desc || '（无描述）')),
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '位置'),
							h('div', { style: S.doc }, (sel.root === 'project' ? '项目级' : '全局') + '技能 · ' + (sel.path || '')))
					)
				) : null,
				toast ? h('div', { style: S.toast }, toast) : null
			)
		}

		// ── 入选题库弹窗：手填预设 → 确定 → 入队并触发生成 ──
		const PRESET_FIELDS = [
			{ key: 'genre', label: '赛道', kind: 'select', options: [AUTO_GENRE].concat(GENRES),
			  hint: '**填入即以此为准**。已按来源与标题预填，但它只是建议——拿不准就选「自动判断」交给 Agent，别把一个错的值带下去。' },
			{ key: 'count', label: '选题数量', kind: 'number', ph: '3', required: true,
			  hint: '默认 3。探索时填 5；心里有数时填 1，省时间。' },
			{ key: 'angle', label: '角度倾向', kind: 'text', ph: '如：从普通人处境切入 / 避开宏观评论',
			  hint: '影响我往哪个方向找角度。' },
			{ key: 'exclude', label: '排除项', kind: 'text', ph: '如：不站队、不煽情、不写政策解读',
			  hint: '比正面描述更有约束力。' },
			{ key: 'viewpoint', label: '个人观点', kind: 'area', ph: '如：这是机制问题，不是个人自律问题',
			  hint: '写方向而不是完整论述；会随选题一路传到写作与审稿。' }
		]

		// ── 手动投料弹窗 ──
		// 用户贴一段文字 / 传截图 → 落盘到 materials/inbox → 触发 Agent 提炼
		// （不自动进选题库：先让 Agent 判断信息够不够，避免"一条微博就生成三个方案"）
		function InboxDialog(props) {
			const [text, setText] = React.useState('')
			const [files, setFiles] = React.useState([])
			const [busy, setBusy] = React.useState(false)
			const [note, setNote] = React.useState('')
			const M = {
				overlay: {
					position: 'fixed', inset: 0, background: 'rgba(0,0,0,.38)', zIndex: 9999,
					display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px'
				},
				box: {
					width: '560px', maxWidth: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
					background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '14px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', boxShadow: '0 18px 48px rgba(0,0,0,.22)',
					color: 'var(--dsw-alias-label-primary)'
				},
				head: { padding: '16px 18px 12px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
				title: { fontSize: '15.5px', fontWeight: 650 },
				sub: { marginTop: '5px', fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)' },
				body: { padding: '14px 18px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '13px' },
				label: { fontSize: '12.5px', fontWeight: 600 },
				area: {
					width: '100%', boxSizing: 'border-box', marginTop: '5px', minHeight: '120px', resize: 'vertical',
					padding: '8px 10px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', font: 'inherit', outline: 'none'
				},
				hint: { marginTop: '4px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.6' },
				foot: { padding: '12px 18px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', display: 'flex', justifyContent: 'flex-end', gap: '8px' },
				btn: { padding: '7px 16px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
				primary: { padding: '7px 18px', borderRadius: '8px', border: '1px solid var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)', font: 'inherit', fontWeight: 600, cursor: 'pointer' }
			}

			const readAsDataUrl = (file) => new Promise((resolve) => {
				const fr = new FileReader()
				fr.onload = () => resolve({ name: file.name, dataUrl: String(fr.result || '') })
				fr.onerror = () => resolve(null)
				fr.readAsDataURL(file)
			})

			const submit = async () => {
				if (!text.trim() && files.length === 0) { setNote('文字和图片至少给一样'); return }
				setBusy(true); setNote('')
				try {
					const images = []
					for (const f of files) {
						const one = await readAsDataUrl(f)
						if (one) images.push(one)
					}
					await props.onSubmit(text.trim(), images)
					setBusy(false)
				} catch (err) {
					setBusy(false)
					setNote('投料失败：' + String((err && err.message) || err))
				}
			}

			return h('div', { style: M.overlay, onClick: (ev) => { if (ev.target === ev.currentTarget) props.onClose() } },
				h('div', { style: M.box }, [
					h('div', { style: M.head }, [
						h('div', { style: M.title }, '手动投料'),
						h('div', { style: M.sub }, '贴一段文字、一个链接，或传截图。'
							+ '素材会存到 materials/inbox/，然后交给 Agent 提炼事实与角度——'
							+ '**不会自动进选题库**，先让它判断信息够不够。')
					]),
					h('div', { style: M.body }, [
						h('div', null, [
							h('div', { style: M.label }, '素材文字'),
							h('textarea', {
								style: M.area,
								placeholder: '粘贴新闻片段、原始数据、一段话，或你自己的想法（也可以只传图）',
								value: text, onChange: (ev) => setText(ev.target.value)
							})
						]),
						h('div', null, [
							h('div', { style: M.label }, '截图 / 图片（可多选）'),
							h('input', {
								type: 'file', accept: 'image/*', multiple: true,
								style: Object.assign({}, M.area, { minHeight: '0', padding: '6px' }),
								onChange: (ev) => setFiles(Array.from(ev.target.files || []))
							}),
							h('div', { style: M.hint }, files.length
								? '已选 ' + files.length + ' 张：' + files.map((f) => f.name).join('、')
								: '单张上限 12MB；截图建议只截关键区域，Agent 读图后会更准。')
						]),
						note ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #c0392b)' } }, note) : null
					]),
					h('div', { style: M.foot }, [
						h('button', { style: M.btn, type: 'button', onClick: props.onClose }, '取消'),
						h('button', {
							style: M.primary, type: 'button', disabled: busy, onClick: submit
						}, busy ? '处理中…' : '存下并让 Agent 分析')
					])
				])
			)
		}

		function EnqueueDialog(props) {
			const row = props.row
			const [form, setForm] = React.useState({
				count: '3', angle: '', exclude: '', viewpoint: '',
				genre: guessGenre(row)          // 按来源预填，用户可改
			})
			const [busy, setBusy] = React.useState(false)
			const set = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

			const M = {
				overlay: {
					position: 'fixed', inset: 0, background: 'rgba(0,0,0,.38)', zIndex: 9999,
					display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px'
				},
				box: {
					width: '520px', maxWidth: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
					background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '14px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', boxShadow: '0 18px 48px rgba(0,0,0,.22)',
					color: 'var(--dsw-alias-label-primary)'
				},
				head: { padding: '16px 18px 12px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
				title: { fontSize: '15.5px', fontWeight: 650 },
				sub: { marginTop: '5px', fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)' },
				body: { padding: '14px 18px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '13px' },
				label: { fontSize: '12.5px', fontWeight: 600 },
				input: {
					width: '100%', boxSizing: 'border-box', marginTop: '5px', padding: '7px 10px', borderRadius: '8px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'var(--dsw-alias-bg-layer-2, transparent)',
					color: 'inherit', font: 'inherit', outline: 'none'
				},
				area: {
					width: '100%', boxSizing: 'border-box', marginTop: '5px', minHeight: '58px', resize: 'vertical',
					padding: '7px 10px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', font: 'inherit', outline: 'none'
				},
				hint: { marginTop: '4px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
				foot: { padding: '12px 18px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', display: 'flex', justifyContent: 'flex-end', gap: '8px' },
				btn: { padding: '7px 16px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
				primary: { padding: '7px 18px', borderRadius: '8px', border: '1px solid var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)', font: 'inherit', fontWeight: 600, cursor: 'pointer' }
			}

			const confirm = async () => {
				setBusy(true)
				try {
					await props.onConfirm(row, {
						count: Number(form.count) || 3,
						angle: form.angle.trim(),
						exclude: form.exclude.trim(),
						viewpoint: form.viewpoint.trim(),
						genre: form.genre === AUTO_GENRE ? '' : form.genre
					})
					props.onClose()
				} finally {
					setBusy(false)
				}
			}

			return h('div', {
				style: M.overlay,
				onClick: (ev) => { if (ev.target === ev.currentTarget && !busy) props.onClose() }
			},
				h('div', { style: M.box },
					h('div', { style: M.head },
						h('div', { style: M.title }, '入选题库'),
						h('div', { style: M.sub }, row.title + '  ·  ' + row.platform + ' · ' + row.date,
							// 弹窗里也要能回看原文：否则点开弹窗就找不到那篇文章了。
							row.url ? h('a', {
								href: row.url, target: '_blank', rel: 'noreferrer noopener',
								style: { marginLeft: '8px', color: 'inherit', textDecoration: 'underline' },
								title: '在新标签页打开原文'
							}, '打开原文 ↗') : null)),
					h('div', { style: M.body },
						PRESET_FIELDS.map((f) => h('div', { key: f.key },
							h('div', { style: M.label }, f.label + (f.required ? ' *' : '')),
							f.kind === 'area'
								? h('textarea', {
									style: M.area, value: form[f.key], placeholder: f.ph,
									onChange: (ev) => set(f.key, ev.target.value)
								})
								: f.kind === 'select'
									? h('select', {
										style: Object.assign({}, M.input, { cursor: 'pointer' }),
										value: form[f.key],
										onChange: (ev) => set(f.key, ev.target.value)
									}, (f.options || []).map((o) => h('option', { key: o, value: o }, o)))
									: h('input', {
										style: M.input, value: form[f.key], placeholder: f.ph,
										type: f.kind === 'number' ? 'number' : 'text',
										onChange: (ev) => set(f.key, ev.target.value)
									}),
							h('div', { style: M.hint }, f.hint))),
						h('div', { style: Object.assign({}, M.hint, { fontSize: '11px' }) },
							'* 为必填；其余留空即按默认生成。')),
					h('div', { style: M.foot },
						h('button', { style: M.btn, type: 'button', disabled: busy, onClick: props.onClose }, '取消'),
						h('button', { style: M.btn, type: 'button', disabled: busy, onClick: () => setForm({ count: '3', angle: '', exclude: '', viewpoint: '', genre: guessGenre(row) }) }, '清空'),
						h('button', { style: M.primary, type: 'button', disabled: busy, onClick: confirm }, busy ? '提交中…' : '确定并生成')))
			)
		}

		// ── 每日热榜：7 个平台的「今天大家在搜什么」 ──
		// 和「爆文库」是**两个平级模块**，不是一页里的两个页签：
		//   热榜 = 实时风向，7 个平台、天天变、7 天滚动归档；
		//   爆文库 = 已经跑出数据的文章，按日期回溯、带封面和互动明细。
		// 早先把两者塞进一个「素材库」页签，结果爆文库根本找不到入口。
		function HotRankLibrary(props) {
			const [arch, setArch] = React.useState(() => loadMaterialArchive())
			const [fetching, setFetching] = React.useState(false)
			const [fetchNote, setFetchNote] = React.useState('')
			// 采集后是否自动生成选题。默认开——用户要的就是一条龙。
			// 但保留开关：有时候只想更新素材、不想跑 20 个选题（那要花时间）。
			const [autoGen, setAutoGen] = React.useState(() => {
				try {
					const v = window.localStorage.getItem('dsh-workbench:autoGenAfterFetch')
					return v === null ? true : v === '1'
				} catch (err) { return true }
			})
			React.useEffect(() => {
				try { window.localStorage.setItem('dsh-workbench:autoGenAfterFetch', autoGen ? '1' : '0') } catch (err) { /* 忽略 */ }
			}, [autoGen])
			const [scheduleHour, setScheduleHour] = React.useState(null)
			const dates = (arch.dates || []).slice().sort()
			const byDate = arch.byDate || {}
			const [day, setDay] = React.useState(
				arch.today && byDate[arch.today] ? arch.today : (dates[dates.length - 1] || ''))
			const rowsOfDay = byDate[day] || []
			const platforms = [...new Set(rowsOfDay.map((r) => r.platform))]
			const [tab, setTab] = React.useState('')
			const activeTab = platforms.indexOf(tab) >= 0 ? tab : (platforms[0] || '')
			const [q, setQ] = React.useState('')
			const rowState = props.rowState || {}
			const pending = props.pending || {}

			React.useEffect(() => {
				let alive = true
				apiGet('/api/workbench/materials').then((d) => {
					if (!alive || !d || !d.snapshot) return
					setArch(d.snapshot)
					saveMaterialArchive(d.snapshot)
					if (d.scheduleHour != null) setScheduleHour(d.scheduleHour)
				}).catch(() => { /* 用内置快照兜底 */ })
				return () => { alive = false }
			}, [])

			const doFetch = async () => {
				setFetching(true); setFetchNote('')
				try {
					const r = await apiPost('/api/workbench/fetch', {})
					if (r && r.snapshot) {
						setArch(r.snapshot); saveMaterialArchive(r.snapshot)
						if (r.snapshot.today && r.snapshot.byDate && r.snapshot.byDate[r.snapshot.today]) {
							setDay(r.snapshot.today); setQ('')
						}
					}
					const okFetch = !!(r && r.ok)
					setFetchNote(okFetch
						? '已更新 ' + ((r.snapshot && r.snapshot.fetchedAt) || '')
						: '采集失败：' + String((r && r.error) || '未知原因'))

					// 采集成功后自动生成今日选题。
					// 链路：采集 → topic-pipeline 写加工指令 → 投给 Agent 按四步加工 → 落库。
					// 以前这一步是断的：采集只更新界面，没人把指令交给 Agent，
					// 于是「今日」永远是 0 条。
					if (okFetch && autoGen && typeof props.onGenerateDaily === 'function') {
						setFetchNote('素材已更新，正在生成今日选题…')
						try {
							await props.onGenerateDaily()
							setFetchNote('素材已更新，选题生成指令已投递给 Agent')
						} catch (err) {
							setFetchNote('素材已更新，但生成选题失败：' +
								String((err && err.message) || err))
						}
					}
				} catch (err) {
					setFetchNote('采集失败：' + String((err && err.message) || err))
				} finally { setFetching(false) }
			}

			const pill = { padding: '4px 11px', borderRadius: '999px', cursor: 'pointer', font: 'inherit', fontSize: '12.5px', background: 'transparent' }
			const sel = {
				padding: '5px 9px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
				background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', fontSize: '12.5px', outline: 'none'
			}
			const dayLabel = (d) => d === arch.today ? d + '（今天）' : d
			const qq = q.trim().toLowerCase()

			// 平台卡片：每条榜单露前三 + 热度 + 快照时间（对应竞品「全网热榜」的卡片总览）
			const hotCard = (p) => {
				const list = rowsOfDay.filter((r) => r.platform === p)
				const top = list.slice(0, 3)
				return h('div', {
					key: p, style: {
						border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px',
						padding: '11px 12px', background: 'var(--dsw-alias-bg-layer-1)',
						display: 'flex', flexDirection: 'column', gap: '6px', minHeight: '132px'
					}
				},
					h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px' } },
						h('span', { style: { fontSize: '13px', fontWeight: 650 } }, p),
						h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, list.length + ' 条'),
						h('button', {
							style: Object.assign({}, pill, S.tabOff, { marginLeft: 'auto', fontSize: '11px', padding: '1px 8px' }),
							type: 'button', onClick: () => setTab(p)
						}, '完整榜单 →')),
					top.map((r, i) => h('div', {
						key: r.key, style: { display: 'flex', gap: '6px', fontSize: '12px', lineHeight: '1.5' }
					},
						h('span', { style: { flex: '0 0 auto', color: i === 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', fontWeight: i === 0 ? 650 : 400 } }, (i + 1) + '.'),
						h('span', {
							style: {
								flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
								color: i === 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'
							}
						}, r.title),
						r.hot ? h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, fmtHot(r.hot)) : null)),
					h('div', { style: { marginTop: 'auto', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' } },
						'最新快照 ' + (arch.fetchedAt || '—')))
			}

			if (!dates.length) {
				return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
					h('div', { style: S.head },
						h('h1', { style: S.h1 }, '每日热榜'),
						h('p', { style: S.sub }, '还没有热榜归档。跑 tools/gen-materials.py 抓一次，或点下面的按钮。'),
						h('div', { style: S.stageHead },
							h('button', {
								style: Object.assign({}, pill, S.tabOn, { cursor: fetching ? 'default' : 'pointer' }),
								type: 'button', disabled: fetching, onClick: doFetch
							}, fetching ? '采集中…' : '手动采集当天热点'),
							h('button', {
								style: Object.assign({}, pill, S.tabOff), type: 'button',
								onClick: () => { props.onOpenInbox(); setFetchNote('') }
							}, '手动投料'),
							h('label', {
								style: {
									display: 'inline-flex', alignItems: 'center', gap: '5px',
									fontSize: '12.5px', cursor: 'pointer', userSelect: 'none',
									color: 'var(--dsw-alias-label-secondary)'
								},
								title: '勾上：采集成功后自动把「生成今日选题」指令投给 Agent'
							},
								h('input', {
									type: 'checkbox', checked: autoGen,
									onChange: (ev) => setAutoGen(ev.target.checked)
								}),
								'采集后自动生成选题'),
							fetchNote ? h('span', {
								style: {
									marginLeft: 'auto', fontSize: '12px', whiteSpace: 'nowrap',
									color: fetchNote.indexOf('失败') >= 0 ? 'var(--dsw-alias-label-error, #c0392b)' : 'var(--dsw-alias-label-secondary)'
								}
							}, fetchNote) : null)),
					h('div', { style: S.body }, h('div', { style: S.placeholder }, '（空）')))
			}

			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
				h('div', { style: S.head },
					h('h1', { style: S.h1 }, '每日热榜'),
					h('p', { style: S.sub }, '微博 / 知乎 / 百度 / 抖音 / 今日头条 / B站 / AI 共 ' + platforms.length +
						' 路榜单，只保留最近 7 天，默认看当天。归档 ' + (arch.fetchedAt || '—') +
						'；可查区间 ' + (dates[0] || '—') + ' ~ ' + (dates[dates.length - 1] || '—') +
						'（' + dates.length + ' 天）' +
						(scheduleHour != null ? '；每天 ' + scheduleHour + ':00 自动补采。' : '。')),
					h('div', { style: S.stageHead },
						h('input', {
							type: 'date', value: day,
							min: dates[0] || undefined, max: dates[dates.length - 1] || undefined,
							style: sel,
							onChange: (ev) => { setDay(ev.target.value); setQ('') }
						}),
						h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
							rowsOfDay.length ? '· ' + rowsOfDay.length + ' 条' : '· 该日期没有归档'),
						arch.today && day !== arch.today && byDate[arch.today]
							? h('button', {
								style: Object.assign({}, pill, S.tabOff), type: 'button',
								onClick: () => { setDay(arch.today); setQ('') }
							}, '回到今天') : null,
						h('button', {
							style: Object.assign({}, pill, S.tabOn, { cursor: fetching ? 'default' : 'pointer' }),
							type: 'button', disabled: fetching, onClick: doFetch
						}, fetching ? '采集中…' : '手动采集当天热点'),
						h('label', {
								style: {
									display: 'inline-flex', alignItems: 'center', gap: '5px',
									fontSize: '12.5px', cursor: 'pointer', userSelect: 'none',
									color: 'var(--dsw-alias-label-secondary)'
								},
								title: '勾上：采集成功后自动把「生成今日选题」指令投给 Agent'
							},
								h('input', {
									type: 'checkbox', checked: autoGen,
									onChange: (ev) => setAutoGen(ev.target.checked)
								}),
								'采集后自动生成选题'),
						h('button', {
							style: Object.assign({}, pill, S.tabOff), type: 'button',
							onClick: () => { props.onOpenInbox(); setFetchNote('') }
						}, '手动投料'),
						fetchNote ? h('span', {
							style: {
								marginLeft: 'auto', fontSize: '12px', whiteSpace: 'nowrap',
								color: fetchNote.indexOf('失败') >= 0 ? 'var(--dsw-alias-label-error, #c0392b)' : 'var(--dsw-alias-label-secondary)'
							}
						}, fetchNote) : null)),
				h('div', { style: S.body },
					props.error ? h('div', { style: S.err }, props.error) : null,
					!rowsOfDay.length
						? h('div', { style: S.placeholder },
							'「' + dayLabel(day) + '」这一天没有归档数据。有归档的日期：' + dates.join('、'))
						: h('div', null,
							h('div', { style: Object.assign({}, S.grid, { gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))' }) },
								platforms.map(hotCard)),
							// 投递目标：点「入选题库」后，分析指令会投到这个会话。
							// 以前这一步是隐式的（靠「最近更新」猜），投错了没人知道，
							// 结果 job 一直卡在 pending。现在显式显示出来。
							(() => {
								const t = props.targetSession
								if (!t) return null
								const bad = !!t.error || t.how === '退回最近更新'
								const color = bad ? '#b76e00' : '#12b76a'
								return h('div', {
									style: {
										display: 'flex', alignItems: 'center', gap: '7px',
										marginTop: '10px', padding: '7px 11px', borderRadius: '8px',
										fontSize: '12.5px', lineHeight: 1.5,
										background: 'color-mix(in srgb, ' + color + ' 9%, transparent)',
										border: '1px solid color-mix(in srgb, ' + color + ' 34%, transparent)'
									}
								},
									h('span', { style: { color: color, fontWeight: 650 } },
										bad ? '⚠️ 投递目标' : '投递目标'),
									h('span', null,
										t.error ? String(t.error)
											: '「' + t.title + '」　（' + t.how + '）'),
									h('span', { style: { opacity: 0.62, marginLeft: '2px' } },
										bad
											? '没找到名为「Agent-公众号」的会话，指令会投给最近活跃的那个，可能投错。建议新建或改名一个会话为 Agent-公众号。'
											: '点「入选题库」后，分析指令会投到这个会话'))
							})(),
							h('div', { style: Object.assign({}, S.stageHead, { marginTop: '12px' }) },
								h('span', { style: S.stageName }, '逐条明细'),
								platforms.map((p) => h('button', {
									key: p, type: 'button',
									style: Object.assign({}, pill, activeTab === p ? S.tabOn : S.tabOff),
									onClick: () => setTab(p)
								}, p + ' · ' + rowsOfDay.filter((r) => r.platform === p).length)),
								h('input', {
									style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '180px', marginLeft: 'auto' }),
									placeholder: '搜索话题…', value: q, onChange: (ev) => setQ(ev.target.value)
								})),
							h('div', { style: S.wrap },
								h('table', { style: S.table },
									h('thead', null, h('tr', null,
										h('th', { style: Object.assign({}, S.th, S.num) }, '序号'),
										h('th', { style: S.th }, '热榜话题'),
										h('th', { style: S.th }, '热度'),
										h('th', { style: S.th }, '原文链接'),
										h('th', { style: S.th }, '话题日期'),
										h('th', { style: S.th }, '操作'))),
									h('tbody', null, rowsOfDay
										.filter((r) => r.platform === activeTab && (!qq || (r.title || '').toLowerCase().includes(qq)))
										.map((r) => h('tr', { key: r.key },
											h('td', { style: Object.assign({}, S.td, S.num) }, r.rank),
											h('td', { style: S.td }, [
												h('div', null, r.title),
												r.summary ? h('div', {
													style: {
														marginTop: '3px', fontSize: '11.5px', lineHeight: '1.5',
														color: 'var(--dsw-alias-label-secondary)'
													}
												}, r.summary + (r.sourceName ? '　— ' + r.sourceName : '')) : null
											]),
											h('td', { style: S.td }, fmtHot(r.hot)),
											h('td', { style: S.td }, r.url
												? h('a', { href: r.url, target: '_blank', rel: 'noreferrer noopener', style: S.mono }, '打开原文')
												: h('span', { style: S.mono }, '—')),
											h('td', { style: Object.assign({}, S.td, S.mono) }, r.date),
											h('td', { style: S.td },
												rowState[r.key] === 'analyzed'
													? h('button', { style: Object.assign({}, S.mini, S.miniOff), type: 'button', disabled: true }, '已出选题')
													: h('button', {
														style: S.mini, type: 'button', disabled: !!pending[r.key],
														onClick: () => props.onPick(r)
													}, pending[r.key] ? '入队中…'
														: rowState[r.key] === 'queued' ? '待分析 · 改参数' : '入选题库'))))))))))
		}

		// ── 爆文库：已经跑出数据的文章，按平台分页签 ──
		// 信息架构照竞品「爆文库」：平台切换 → 一行筛选（日期 / 分类 / 排序 / 搜索 / 结果数）
		//   → 表格（名次 · 封面+标题+账号 · 热度 · 互动明细 · 发布于 · 操作）
		// **不抄会员墙**：数据全在本地缓存，点「原文」直达，不做付费解锁。
		// 今日头条暂不接：它只有关键词搜索接口、没有当日榜单，做出来是空壳，所以不摆死页签。
		//
		// 两个平台的缓存 key 分开存：字段名不一样（公众号是 readLabel/insee/share，
		// 小红书是 inter/like/collect），混在一个 key 里迟早串味。
		const GZH_STORE_KEY = 'dsh-workbench:gzh:hot'
		const XHS_STORE_KEY = 'dsh-workbench:xhs:hot'
		const EMPTY_VIRAL = { byDate: {}, dates: [], categories: [], fetchedAt: '', latest: '' }

		// 两个平台字段名不一样，用一张适配表把差异收在一处，表格只写一遍
		const VIRAL_SRC = {
			gzh: {
				label: '公众号爆文',
				api: '/api/workbench/gzh',
				store: GZH_STORE_KEY,
				note: '每天 18:30 同步前一天的 10w+ 榜单，覆盖 22 个分类；同一天重复采集结果不变，只在补抓时点按钮。',
				metricLabel: '阅读',
				metric: (r) => r.readLabel || fmtHot(r.hot),
				detailLabel: '互动（在看 · 赞 · 转）',
				detail: (r) => fmtHot(r.insee) + ' · ' + fmtHot(r.like) + ' · ' + fmtHot(r.share),
				rank: (r) => r.rank,
				catOf: (r) => (r.cats || [r.category]).filter(Boolean),
				slow: '采集中…（约 100 秒）',
				source: '数据源：红狐 · 公众号 10w+ 榜'
			},
			xhs: {
				label: '小红书爆文',
				api: '/api/workbench/xhs',
				store: XHS_STORE_KEY,
				note: '按日期给单日爆款榜，覆盖 25 个分类；数值是笔记累计互动（赞 + 藏 + 评 + 转）。',
				metricLabel: '互动',
				metric: (r) => fmtHot(r.inter || r.hot),
				detailLabel: '赞 · 藏 · 评',
				detail: (r) => fmtHot(r.like) + ' · ' + fmtHot(r.collect) + ' · ' + fmtHot(r.comment),
				rank: (r) => r.n || r.rank,
				catOf: (r) => (r.cats || [r.category]).filter(Boolean),
				slow: '采集中…（约 90 秒）',
				source: '数据源：红狐 · 小红书单日爆款'
			}
		}

		function loadViral(storeKey) {
			try {
				const raw = window.localStorage.getItem(storeKey)
				const one = raw ? JSON.parse(raw) : null
				return one && one.byDate ? one : EMPTY_VIRAL
			} catch (err) { return EMPTY_VIRAL }
		}
		// localStorage 只有 ~5 MB，而小红书 7 天全量是 8.3 MB、公众号也有几 MB，
		// 直接 setItem 会抛 QuotaExceededError（原来被 catch 吞了，等于**缓存从来没写成功过**）。
		// 所以本地只留「最近一天 × 热度前 200 条」当离线兜底；
		// 完整 7 天数据始终走 GET 接口实时读快照，日期选择器也由接口那份驱动。
		// 快照有 8 MB 级别（小红书 7 天 8399 行 = 8.3 MB），一次性塞给浏览器会：
		//   ① 卡住首屏（JSON.parse 8 MB 在主线程上是可见的停顿）；
		//   ② 撑爆 localStorage（配额 ~5 MB，setItem 直接抛 QuotaExceededError）。
		// 所以 GET 分两次：
		//   ?meta=1 → 只给 { dates, counts, fetchedAt }（几百字节）
		//   ?date=X → 只给这一天的行
		// 本地缓存只留最近一天的前 VIRAL_CACHE_ROWS 条，纯离线兜底。
		const VIRAL_CACHE_ROWS = 200
		const PAGE_SIZE = 50
		function trimViral(a) {
			const dates = (a.dates || []).slice().sort()
			const last = dates[dates.length - 1]
			if (!last) return a
			const rows = (a.byDate || {})[last] || []
			return {
				byDate: { [last]: rows.slice().sort((x, y) => (y.hot || 0) - (x.hot || 0)).slice(0, VIRAL_CACHE_ROWS) },
				dates: [last], categories: a.categories || [], fetchedAt: a.fetchedAt || '', latest: last
			}
		}
		function saveViral(storeKey, a) {
			try {
				window.localStorage.setItem(storeKey, JSON.stringify(trimViral(a)))
			} catch (err) {
				// 真写不进去就清掉旧值，别留一份过期的把人骗了
				try { window.localStorage.removeItem(storeKey) } catch (e2) { /* 什么都不做 */ }
			}
		}

		function ViralLibrary(props) {
			const [plat, setPlat] = React.useState('gzh')
			// 每个平台各自一份：meta（日期/条数）+ 当前这一天的行
			const [cache, setCache] = React.useState(() => ({
				gzh: loadViral(GZH_STORE_KEY), xhs: loadViral(XHS_STORE_KEY)
			}))
			const [meta, setMeta] = React.useState({ gzh: null, xhs: null })
			const [rowsByDate, setRowsByDate] = React.useState({ gzh: {}, xhs: {} })
			const [busy, setBusy] = React.useState(false)
			const [loading, setLoading] = React.useState(false)
			const [note, setNote] = React.useState('')
			const [day, setDay] = React.useState('')
			const [cat, setCat] = React.useState('全部')
			const [sortBy, setSortBy] = React.useState('hot')
			const [q, setQ] = React.useState('')
			const [page, setPage] = React.useState(0)
			const listTop = React.useRef(null)
			const rowState = props.rowState || {}
			const pending = props.pending || {}

			const cfg = VIRAL_SRC[plat]
			const arch = cache[plat] || EMPTY_VIRAL
			const m = meta[plat]
			const dates = ((m && m.dates) || arch.dates || []).slice().sort()
			const counts = (m && m.counts) || {}
			const fetchedAt = (m && m.fetchedAt) || arch.fetchedAt || ''
			const latest = (m && m.latest) || arch.latest || ''
			const dayKey = day && dates.indexOf(day) >= 0 ? day
				: (latest && dates.indexOf(latest) >= 0 ? latest : (dates[dates.length - 1] || ''))
			// 优先用接口取回的那一天；接口没回来之前先用本地缓存顶一下
			const rows = (rowsByDate[plat] && rowsByDate[plat][dayKey]) || (arch.byDate || {})[dayKey] || []

			// 取元信息（日期 + 每天条数），几百字节
			const loadMeta = (key) => apiGet('/api/workbench/' + key + '?meta=1').then((d) => {
				if (!d || !d.ok || !d.meta) return
				setMeta((prev) => Object.assign({}, prev, { [key]: d.meta }))
			}).catch(() => { /* 没采过就用空态 */ })

			React.useEffect(() => { loadMeta('gzh'); loadMeta('xhs') }, [])

			// 换平台 / 换日期才去取那一天的明细
			React.useEffect(() => {
				if (!dayKey) return
				if (rowsByDate[plat] && rowsByDate[plat][dayKey]) return
				let alive = true
				setLoading(true)
				apiGet('/api/workbench/' + plat + '?date=' + encodeURIComponent(dayKey)).then((d) => {
					if (!alive || !d || !d.ok || !Array.isArray(d.rows)) return
					setRowsByDate((prev) => Object.assign({}, prev, {
						[plat]: Object.assign({}, prev[plat], { [dayKey]: d.rows })
					}))
					if (d.meta) setMeta((prev) => Object.assign({}, prev, { [plat]: d.meta }))
					// 顺手把这一天存进本地缓存，离线时还能看见（trimViral 会截断）
					setCache((prev) => {
						const next = Object.assign({}, prev, {
							[plat]: { byDate: { [dayKey]: d.rows }, dates: [dayKey], categories: [], fetchedAt: (d.meta && d.meta.fetchedAt) || '', latest: dayKey }
						})
						saveViral(VIRAL_SRC[plat].store, next[plat])
						return next
					})
				}).catch(() => { /* 取不到就空着 */ }).finally(() => { if (alive) setLoading(false) })
				return () => { alive = false }
			}, [plat, dayKey])

			const doFetch = async () => {
				setBusy(true); setNote('')
				try {
					const r = await apiPost(cfg.api, {})
					setNote(r && r.ok
						? '已采集 ' + ((r.snapshot && r.snapshot.fetchedAt) || '')
						: '采集失败：' + String((r && r.error) || '未知原因'))
					if (r && r.ok) {
						// 采完不要整份塞进 state，只重新拉元信息 + 回到最新一天
						setRowsByDate((prev) => Object.assign({}, prev, { [plat]: {} }))
						setDay(''); setCat('全部'); setQ('')
						await loadMeta(plat)
					}
				} catch (err) {
					setNote('采集失败：' + String((err && err.message) || err))
				} finally { setBusy(false) }
			}

			const pill = { padding: '4px 11px', borderRadius: '999px', cursor: 'pointer', font: 'inherit', fontSize: '12.5px', background: 'transparent' }
			const sel = {
				padding: '5px 9px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
				background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', fontSize: '12.5px', outline: 'none'
			}

			const catOptions = ['全部'].concat(
				[...new Set(rows.flatMap((r) => cfg.catOf(r)))].sort((a, b) => {
					const pa = (a === '总排名' || a === '综合全部') ? -1 : 0
					const pb = (b === '总排名' || b === '综合全部') ? -1 : 0
					return pa - pb || a.localeCompare(b, 'zh')
				}))
			const qq = q.trim().toLowerCase()
			const filtered = rows
				.filter((r) => cat === '全部' || cfg.catOf(r).indexOf(cat) >= 0)
				.filter((r) => !qq || (r.title || '').toLowerCase().includes(qq) || (r.account || '').toLowerCase().includes(qq))
				.sort((a, b) => sortBy === 'time'
					? String(b.publicTime || '').localeCompare(String(a.publicTime || ''))
					: (b.hot || 0) - (a.hot || 0))

			// 小红书一天就有 1200 行（25 分类 × 50 条），全渲染会让滚动卡顿，
			// 所以分页。翻页后回到顶部，否则用户以为没反应。
			const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
			const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
			const gotoPage = (n) => {
				setPage(Math.min(Math.max(0, n), pageCount - 1))
				if (listTop.current) listTop.current.scrollTop = 0
			}

			// 爆文行 → 入选题库的形状（与热榜行同构，所以直接复用 props.onPick）
			const pick = (r) => props.onPick({
				key: r.key, platform: plat === 'gzh' ? '公众号' : '小红书', title: r.title,
				hot: r.hot, url: r.url, date: r.date, summary: r.summary, account: r.account
			})

			const platTab = (key) => h('button', {
				key, type: 'button',
				style: Object.assign({}, pill, plat === key ? S.tabOn : S.tabOff),
				onClick: () => { setPlat(key); setDay(''); setCat('全部'); setQ(''); setNote('') }
			}, VIRAL_SRC[key].label)

			// 表格行：12 层嵌套的 h() 数不清括号，所以先拼成节点数组再组装。
			const rowNodes = pageRows.map((r) => h('tr', { key: r.key },
				h('td', { style: Object.assign({}, S.td, S.num) }, cfg.rank(r)),
				// 封面 + 标题 + 账号·分类，对应截图里的「文章 / 账号」列
				h('td', { style: S.td }, h('div', { style: { display: 'flex', gap: '9px', alignItems: 'flex-start' } },
					r.cover ? (r.url
						? h('a', {
							href: r.url, target: '_blank', rel: 'noreferrer noopener',
							title: '打开原文', style: { flex: '0 0 auto', display: 'block', lineHeight: 0 }
						}, h('img', {
							src: r.cover, alt: '', loading: 'lazy',
							style: {
								width: '54px', height: '38px', objectFit: 'cover',
								borderRadius: '5px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', cursor: 'pointer'
							},
							onError: (ev) => { ev.target.style.visibility = 'hidden' }
						}))
						: h('img', {
							src: r.cover, alt: '', loading: 'lazy',
							style: {
								width: '54px', height: '38px', flex: '0 0 auto', objectFit: 'cover',
								borderRadius: '5px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)'
							},
							onError: (ev) => { ev.target.style.visibility = 'hidden' }
						})) : null,
					h('div', { style: { minWidth: 0 } },
						// 标题就是原文入口：整行最显眼的位置，点标题直接跳原文。
						// 光靠右下角一个「↗」没人找得到（用户反馈过），所以标题、封面、
						// 账号名、以及操作列的按钮全部可点。
						r.url ? h('a', {
							href: r.url, target: '_blank', rel: 'noreferrer noopener',
							style: {
								fontWeight: 550, lineHeight: '1.5', color: 'inherit',
								textDecoration: 'none', display: 'block'
							},
							title: '打开原文：' + (r.title || ''),
							onMouseEnter: (ev) => { ev.currentTarget.style.textDecoration = 'underline' },
							onMouseLeave: (ev) => { ev.currentTarget.style.textDecoration = 'none' }
						}, r.title, h('span', {
							style: {
								marginLeft: '6px', fontSize: '11px', fontWeight: 400,
								color: 'var(--dsw-alias-label-secondary)'
							}
						}, '↗'))
							: h('div', { style: { fontWeight: 550, lineHeight: '1.5' } }, r.title),
						h('div', { style: { marginTop: '3px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } },
							r.accountUrl ? h('a', {
								href: r.accountUrl, target: '_blank', rel: 'noreferrer noopener',
								style: { color: 'inherit', textDecoration: 'none' }, title: '打开账号主页',
								onMouseEnter: (ev) => { ev.currentTarget.style.textDecoration = 'underline' },
								onMouseLeave: (ev) => { ev.currentTarget.style.textDecoration = 'none' }
							}, r.account || '—') : (r.account || '—'),
							' · ' + cfg.catOf(r).join('/'),
							r.original ? h('span', { style: { marginLeft: '6px' } }, '原创') : null),
						r.summary ? h('div', {
							style: {
								marginTop: '3px', fontSize: '11.5px', lineHeight: '1.5',
								color: 'var(--dsw-alias-label-secondary)',
								display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
							}
						}, r.summary) : null))),
				h('td', { style: S.td }, h('span', { style: { fontWeight: 600 } }, cfg.metric(r) || '—')),
				h('td', { style: Object.assign({}, S.td, S.mono) }, cfg.detail(r)),
				h('td', { style: Object.assign({}, S.td, S.mono) }, (r.publicTime || '—').slice(0, 16)),
				h('td', { style: S.td }, h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
					rowState[r.key] === 'analyzed'
						? h('button', { style: Object.assign({}, S.mini, S.miniOff), type: 'button', disabled: true }, '已出选题')
						: h('button', {
							style: S.mini, type: 'button', disabled: !!pending[r.key],
							onClick: () => pick(r)
						}, pending[r.key] ? '入队中…'
							: rowState[r.key] === 'queued' ? '待分析 · 改参数' : '收藏素材'),
					r.url ? h('a', {
						href: r.url, target: '_blank', rel: 'noreferrer noopener',
						style: {
							fontSize: '12px', whiteSpace: 'nowrap', textDecoration: 'none',
							padding: '3px 8px', borderRadius: '7px',
							border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
							color: 'var(--dsw-alias-label-primary, inherit)'
						},
						title: '在新标签页打开原文',
						onMouseEnter: (ev) => { ev.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04))' },
						onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent' }
					}, '打开原文') : null))))

			const tableNode = h('div', { style: S.wrap, ref: listTop },
				h('table', { style: S.table },
					h('thead', null, h('tr', null,
						h('th', { style: Object.assign({}, S.th, S.num) }, '名次'),
						h('th', { style: S.th }, '文章 / 账号'),
						h('th', { style: S.th }, cfg.metricLabel),
						h('th', { style: S.th }, cfg.detailLabel),
						h('th', { style: S.th }, '发布于'),
						h('th', { style: S.th }, '操作'))),
					h('tbody', null, rowNodes)))

			const pager = pageCount > 1 ? h('div', {
				style: {
					display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center',
					padding: '10px 0 2px', fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)'
				}
			},
				h('button', {
					style: Object.assign({}, pill, page === 0 ? S.tabOff : S.tabOn, { cursor: page === 0 ? 'default' : 'pointer' }),
					type: 'button', disabled: page === 0, onClick: () => gotoPage(page - 1)
				}, '上一页'),
				h('span', null, '第 ' + (page + 1) + ' / ' + pageCount + ' 页 · 共 ' + filtered.length + ' 篇'),
				h('button', {
					style: Object.assign({}, pill, page >= pageCount - 1 ? S.tabOff : S.tabOn, { cursor: page >= pageCount - 1 ? 'default' : 'pointer' }),
					type: 'button', disabled: page >= pageCount - 1, onClick: () => gotoPage(page + 1)
				}, '下一页')) : null

			const toolbar = h('div', { style: Object.assign({}, S.stageHead, { marginTop: '2px' }) },
				h('input', {
					type: 'date', value: dayKey,
					min: dates[0] || undefined,
					max: dates[dates.length - 1] || undefined,
					style: sel,
					onChange: (ev) => { setDay(ev.target.value); setQ(''); setPage(0) }
				}),
				h('select', { style: sel, value: cat, onChange: (ev) => { setCat(ev.target.value); setPage(0) } },
					catOptions.map((c) => h('option', { key: c, value: c }, c === '全部' ? '全部分类' : c))),
				h('select', { style: sel, value: sortBy, onChange: (ev) => { setSortBy(ev.target.value); setPage(0) } },
					h('option', { value: 'hot' }, '按热度'),
					h('option', { value: 'time' }, '按发布时间')),
				h('input', {
					style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '240px' }),
					placeholder: '搜索标题或账号…', value: q,
					onChange: (ev) => { setQ(ev.target.value); setPage(0) }
				}),
				h('span', { style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
					(loading ? '载入中… ' : '') + '筛选结果 ' + filtered.length + ' 篇' +
					(cat === '全部' ? '' : ' · ' + cat) +
					(counts[dayKey] ? '（该日共 ' + counts[dayKey] + ' 篇）' : '')))

			const listBody = !dates.length
				? h('div', { style: S.placeholder }, '还没有' + cfg.label + '数据。点上面的「采集爆文」抓昨天的榜单。')
				: h('div', null, toolbar,
					!filtered.length
						? h('div', { style: S.placeholder }, '没有匹配的爆文（该日期共 ' + rows.length + ' 篇）')
						: h('div', null, tableNode, pager))

			const headBar = h('div', { style: S.head },
				h('h1', { style: S.h1 }, '爆文库'),
				h('p', { style: S.sub }, cfg.note +
					(fetchedAt ? ' 最近采集：' + fetchedAt + '。' : '') +
					'　（今日头条暂未接入：它只提供关键词搜索、没有当日榜单接口。）'),
				h('div', { style: S.stageHead },
					platTab('gzh'),
					platTab('xhs'),
					h('button', {
						style: Object.assign({}, pill, S.tabOn, { cursor: busy ? 'default' : 'pointer' }),
						type: 'button', disabled: busy, onClick: doFetch
					}, busy ? cfg.slow : '采集爆文'),
					h('span', {
						style: { marginLeft: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }
					}, cfg.source),
					note ? h('span', {
						style: {
							fontSize: '12px', whiteSpace: 'nowrap',
							color: note.indexOf('失败') >= 0 ? 'var(--dsw-alias-label-error, #c0392b)' : 'var(--dsw-alias-label-secondary)'
						}
					}, note) : null))

			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
				headBar,
				h('div', { style: S.body },
					props.error ? h('div', { style: S.err }, props.error) : null,
					listBody))
		}

		// ── 选题库：一个「选题方案」（不是一条标题） ──
		// 字段对应选题 skill 的实际产出：
		//   aws-wechat-article-topics → 角度 / 标题候选 / 大纲 / 摘要 / 工作量 / 需额外素材
		//   bigpeng-hot-gzh           → 方向 / 公式化标题 / 为何可能点 / 兑现 / 首选
		function parseJson(s, fallback) {
			try {
				const v = JSON.parse(s || '')
				return Array.isArray(v) ? v : fallback
			} catch (err) { return fallback }
		}

		function TopicLibrary(props) {
			const topics = props.topics || []
			const jobs = props.jobs || []
			const waiting = jobs.filter((j) => j.status === 'pending' || j.status === 'running')
			const statusLabel = { candidate: '候选', selected: '已选', writing: '写作中', done: '已完成', dropped: '已放弃' }

			// ── 「新」标识：生成后 24 小时内 ────────────────────────
			// 不用「是否今天」：那样 23:50 生成的选题到 00:00 就掉标，只挂了 10 分钟。
			// 改成按时间差算，满 24 小时才消失。
			// 用 created_at 不用 updated_at：后者被点开、改状态都会刷新，
			// 「新」会一直挂着不消失，失去意义。
			const NEW_MS = 24 * 60 * 60 * 1000
			const createdMs = (r) => {
				const t = Date.parse(String(r.created_at || '').replace(' ', 'T'))
				return Number.isFinite(t) ? t : NaN
			}
			const isNew = (r) => {
				const t = createdMs(r)
				if (!Number.isFinite(t)) return false
				const age = Date.now() - t
				return age >= 0 && age < NEW_MS
			}
			// 剩余时效，用于 tooltip 提示「还剩几小时」
			const newLeft = (r) => {
				const t = createdMs(r)
				if (!Number.isFinite(t)) return ''
				const left = NEW_MS - (Date.now() - t)
				if (left <= 0) return ''
				const h = Math.floor(left / 3600000)
				return h >= 1 ? '还剩 ' + h + ' 小时' : '还剩不到 1 小时'
			}

			// ── 已创作索引 ──────────────────────────────────────────
			// 为什么不能只看 topic_id：直接新建的草稿没有 topic_id（测试稿就是），
			// 那些稿子明明写过，却会被标成「未写」。所以补一条按标题兜底。
			// 标题取 best_title 优先，与草稿侧用的标题口径保持一致。
			const STAGE_ORDER = ['queued', 'draft', 'polished', 'reviewed', 'formatted', 'illustrated', 'draftbox', 'published']
			const draftsByTopic = {}
			const draftsByTitle = {}
			;(props.drafts || []).forEach((d) => {
				if (d.topic_id) {
					(draftsByTopic[d.topic_id] = draftsByTopic[d.topic_id] || []).push(d)
				}
				const t = String(d.title || '').trim()
				if (t) (draftsByTitle[t] = draftsByTitle[t] || []).push(d)
			})
			/** 返回该选题的草稿数组：先按 topic_id，再按标题兜底合并去重。 */
			const draftsOf = (r) => {
				const byId = draftsByTopic[r.id] || []
				const title = String(r.best_title || r.title || '').trim()
				const byTitle = (draftsByTitle[title] || []).filter(
					(d) => byId.every((x) => x.id !== d.id))
				return byId.concat(byTitle)
			}
			/** 汇总：篇数 + 最远阶段。 */
			const writtenInfo = (r) => {
				const ds = draftsOf(r)
				if (!ds.length) return null
				let far = -1
				ds.forEach((d) => {
					const i = STAGE_ORDER.indexOf(d.status)
					if (i > far) far = i
				})
				return { count: ds.length, stage: STAGE_ORDER[far] || '', stageLabel: DRAFT_LABEL[STAGE_ORDER[far]] || '' }
			}
			const kindLabel = { hot: '🔥 热点', evergreen: '🌲 常青', series: '📚 系列' }
			const sel = props.sel
			const D = {
				row: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', padding: '12px', marginTop: '10px' },
				k: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' },
				v: { fontSize: '12.5px', lineHeight: '1.7' },
				titleItem: { borderTop: '1px dashed var(--dsw-alias-border-l1)', paddingTop: '8px', marginTop: '8px' },
				star: { color: '#b54708', fontWeight: 600 }
			}

			// ── 筛选状态 ──
			const [q, setQ] = React.useState('')
			const [track, setTrack] = React.useState('全部')
			const [src, setSrc] = React.useState('全部')
			// 视图 tab：'all' 全部 / 'today' 今日。
			// 「今日」不单独存日期，直接和 day 联动——两处各存一份必然对不上。
			const [viewTab, setViewTab] = React.useState('all')
			const [day, setDay] = React.useState('')
			const [openRefs, setOpenRefs] = React.useState({})
			const [note, setNote] = React.useState('')

			const flash = (m) => {
				setNote(m)
				window.setTimeout(() => setNote(''), 2400)
			}

			// created_at 是 'YYYY-MM-DD HH:MM:SS'，选题日期只取日期部分
			const dayOf = (r) => String(r.created_at || '').slice(0, 10)
			const uniq = (arr) => [...new Set(arr.filter(Boolean))]
			const tracks = uniq(topics.map((r) => r.track))
				.sort((a, b) => a.localeCompare(b, 'zh'))
			const srcs = uniq(topics.map((r) => r.source_platform))
				.sort((a, b) => a.localeCompare(b, 'zh'))
			const days = uniq(topics.map(dayOf)).sort()

			// 今天的日期字符串。用本地时区，和 created_at 的写入口径一致。
			const todayStr = (() => {
				const d = new Date()
				const p = (n) => String(n).padStart(2, '0')
				return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
			})()
			const todayCount = topics.filter((r) => dayOf(r) === todayStr).length

			const qq = q.trim().toLowerCase()
			const list = topics
				.filter((r) => track === '全部' || r.track === track)
				.filter((r) => src === '全部' || r.source_platform === src)
				.filter((r) => !day || dayOf(r) === day)
				.filter((r) => !qq || [r.title, r.best_title, r.angle, r.hook, r.source_title]
					.some((x) => String(x || '').toLowerCase().includes(qq)))

			const flames = (hot) => {
				const n = Number(hot) || 0
				if (n >= 1000000) return '🔥🔥🔥'
				if (n >= 100000) return '🔥🔥'
				return n > 0 ? '🔥' : ''
			}

			// 发布前核验：**只列能由真实字段推出的项**，不编通用套话。
			// 没有可核验项时不渲染这一块，避免每张卡都挂一段无信息量的提示。
			const checksOf = (r) => {
				const out = []
				if (r.needs_material) out.push('需要额外素材：正文开写前先补齐，否则这一段会空')
				if (!r.best_title) out.push('首选标题未定：发布前必须定下来')
				if (r.word_count && r.word_count >= 3000) out.push('篇幅 ' + r.word_count + ' 字：注意分段与留白，别一屏压满')
				if (r.status === 'dropped') out.push('已放弃：重新启用前先确认这个角度还成立')
				return out
			}

			// 参考依据：来源热点 1 条 + 候选标题 N 条，按实际有值的算。
			// 2026-11-09 修：原来只在 source_title 有值时才出这一条，
			// 而选题的 source_title 普遍为空 → 有 source_url 也看不到链接。
			// 现在改成「标题或链接任一有值就出」，链接单独可点。
			const refsOf = (r) => {
				const out = []
				const hasUrl = !!(r.source_url && String(r.source_url).trim())
				if (r.source_title || hasUrl) {
					out.push({
						label: '热点 · ' + (r.source_platform || '未知来源') +
							(r.source_date ? ' ' + r.source_date : '') +
							(r.source_hot ? ' · 热度 ' + fmtHot(r.source_hot) : ''),
						text: r.source_title || '',
						url: hasUrl ? String(r.source_url).trim() : ''
					})
				}
				const titles = parseJson(r.titles_json, [])
				if (titles.length) out.push({ label: '候选标题 · ' + titles.length + ' 条', text: '', url: '' })
				if (r.job_id != null) out.push({ label: '分析任务 · job #' + r.job_id, text: '', url: '' })
				return out
			}

			const sel2 = {
				padding: '5px 9px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
				background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', fontSize: '12.5px', outline: 'none'
			}
			const pill = { padding: '4px 11px', borderRadius: '999px', cursor: 'pointer', font: 'inherit', fontSize: '12.5px', background: 'transparent' }
			const badge = {
				fontSize: '10.5px', padding: '1px 7px', borderRadius: '999px',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap'
			}
			const blkLabel = { fontSize: '11px', fontWeight: 650, color: 'var(--dsw-alias-label-secondary)', marginBottom: '2px' }
			const blkText = {
				fontSize: '12px', lineHeight: '1.65',
				display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden'
			}

			const copyOne = (r) => {
				const lines = [r.best_title || r.title]
				if (r.angle) lines.push('', '切入角度：' + r.angle)
				if (r.hook) lines.push('为什么值得写：' + r.hook)
				lines.push('', '赛道：' + (r.track || '未设') + '｜来源：' + (r.source_title || '无'))
				copyText(lines.join('\n'), () => flash('已复制到剪贴板'))
			}

			const card = (r) => {
				const checks = checksOf(r)
				const refs = refsOf(r)
				const open = !!openRefs[r.id]
				const title = r.best_title || r.title
				return h('div', {
					key: 't' + r.id,
					style: {
						border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '11px',
						padding: '12px 13px', background: 'var(--dsw-alias-bg-layer-1)',
						display: 'flex', flexDirection: 'column', gap: '8px'
					}
				},
					// 头部：赛道 / 类型 / 热度 / 状态
					h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
						// 「新」放最前面：当天生成的选题要一眼认出来
						isNew(r) ? h('span', {
							style: Object.assign({}, badge, {
								color: '#0b6bcb',
								borderColor: 'color-mix(in srgb, #0b6bcb 50%, transparent)',
								background: 'color-mix(in srgb, #0b6bcb 12%, transparent)',
								fontWeight: 700,
								letterSpacing: '0.5px'
							}),
							title: '生成于 ' + String(r.created_at || '').slice(5, 16) + '　' + newLeft(r)
						}, 'NEW') : null,
						r.track ? h('span', { style: Object.assign({}, badge, { color: 'var(--dsw-alias-label-primary)' }) }, r.track) : null,
						h('span', { style: badge }, kindLabel[r.kind] || r.kind || '选题'),
						r.source_hot ? h('span', { style: { fontSize: '11px' }, title: '来源热度 ' + fmtHot(r.source_hot) }, flames(r.source_hot)) : null,
						// 已创作标识：带篇数与最远阶段，不只是一个「已写」小标
						(() => {
							const w = writtenInfo(r)
							if (!w) return null
							return h('span', {
								style: Object.assign({}, badge, {
									color: '#1a7f37',
									borderColor: 'color-mix(in srgb, #1a7f37 45%, transparent)',
									background: 'color-mix(in srgb, #1a7f37 8%, transparent)',
									fontWeight: 600
								}),
								title: '这个选题已创作 ' + w.count + ' 篇，最远推进到「' + w.stageLabel + '」'
							}, '✓ 已写' + (w.count > 1 ? ' ' + w.count + ' 篇' : '') + ' · ' + w.stageLabel)
						})(),
						h('span', { style: Object.assign({}, badge, { marginLeft: 'auto' }) }, statusLabel[r.status] || r.status || '候选')),

					// 标题（首选标题优先）
					h('div', { style: { fontSize: '13.5px', fontWeight: 650, lineHeight: '1.5' } }, title),

					// 作者观点：选题的核心，排第一位。
					// 没有观点时必须显式提示——空着要能被看见，不能静默跳过，
					// 否则又回到「选题只有主题没有立场，写出来必然发散」的老路。
					h('div', null,
						h('div', { style: Object.assign({}, blkLabel, r.viewpoint ? null : { color: '#b54708' }) },
							'作者观点' + (r.viewpoint ? '' : '（未设，选题不合格）')),
						h('div', {
							style: Object.assign({}, blkText, r.viewpoint ? null : {
								color: '#b54708', fontStyle: 'italic'
							})
						}, r.viewpoint || '这个选题没有观点，只有主题。写出来会发散——补一句能被反驳的判断句。')),

					// 写作切入角度
					r.angle ? h('div', null,
						h('div', { style: blkLabel }, '写作切入角度'),
						h('div', { style: blkText }, r.angle)) : null,

					// 为什么值得写（读者处境，不是作者立场）
					r.hook ? h('div', null,
						h('div', { style: blkLabel }, '读者为什么点'),
						h('div', { style: blkText }, r.hook)) : null,

					// 发布前核验
					checks.length ? h('div', {
						style: {
							borderLeft: '3px solid #b54708', paddingLeft: '8px',
							background: 'color-mix(in srgb, #b54708 6%, transparent)', borderRadius: '4px',
							padding: '5px 8px'
						}
					},
						h('div', { style: { fontSize: '11px', fontWeight: 650, color: '#b54708', marginBottom: '2px' } }, '发布前核验'),
						checks.map((c, i) => h('div', { key: 'c' + i, style: { fontSize: '11.5px', lineHeight: '1.6' } }, '· ' + c))) : null,

					// 参考依据（可折叠）
					refs.length ? h('div', null,
						h('button', {
							type: 'button',
							style: {
								padding: '0', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
								font: 'inherit', fontSize: '11.5px', cursor: 'pointer'
							},
							onClick: () => setOpenRefs((o) => Object.assign({}, o, { [r.id]: !o[r.id] }))
						}, (open ? '▾ ' : '▸ ') + '参考依据 · ' + refs.length + ' 条'),
						open ? h('div', { style: { marginTop: '5px', display: 'flex', flexDirection: 'column', gap: '4px' } },
							refs.map((f, i) => h('div', { key: 'r' + i, style: { fontSize: '11.5px', lineHeight: '1.55' } },
								h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, f.label),
								f.text ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, f.text) : null,
								f.url ? h('a', {
									href: f.url, target: '_blank', rel: 'noreferrer noopener',
									style: {
										fontSize: '11.5px', color: '#0b6bcb', textDecoration: 'none',
										borderBottom: '1px solid color-mix(in srgb, #0b6bcb 40%, transparent)',
										width: 'fit-content', marginTop: '2px'
									},
									title: f.url
								}, '打开原文 ↗') : null))) : null) : null,

					// 操作：四个按钮并排，不分左右两组。
					// 「选为写作」是主操作，用实心主色背景区分；其余保持描边。
					h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: 'auto', flexWrap: 'wrap' } },
						h('button', {
							style: Object.assign({}, S.mini, {
								// 主按钮：实心底 + 反白字，与其余三个拉开层级
								background: 'var(--dsw-alias-label-primary)',
								color: 'var(--dsw-alias-bg-layer-1)',
								borderColor: 'var(--dsw-alias-label-primary)',
								fontWeight: 650
							}),
							type: 'button', disabled: !!props.busy,
							onClick: () => props.onCreateDraft(r)
						}, '选为写作'),
						h('button', { style: S.mini, type: 'button', onClick: () => copyOne(r) }, '复制'),
						h('button', { style: S.mini, type: 'button', onClick: () => props.onOpen(r) }, '详情'),
						h('button', { style: S.mini, type: 'button', onClick: () => props.onRemove(r) }, '移除')))
			}

			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto', position: 'relative' } },
				h('div', { style: S.head },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
						h('h1', { style: S.h1 }, '选题库'),
						// 一键生成今日选题：投递指令给 Agent，走四步加工流程
						h('button', {
							style: Object.assign({}, S.mini, {
								marginLeft: 'auto',
								background: 'var(--dsw-alias-label-primary)',
								color: 'var(--dsw-alias-bg-layer-1)',
								borderColor: 'var(--dsw-alias-label-primary)',
								fontWeight: 650
							}),
							type: 'button',
							disabled: !!props.busy,
							onClick: () => props.onGenerateDaily()
						}, '生成今日选题')),
					h('p', { style: S.sub }, props.loading
						? '正在读取 SQLite…'
						: '共 ' + topics.length + ' 个选题方案（一个方案 = 一个角度，不是一个标题）。'
							+ (waiting.length ? '待分析 ' + waiting.length + ' 条。' : '')
							+ ' 筛选后 ' + list.length + ' 条。'),
					// 视图 tab：全部 / 今日。
					// 「今日」把 day 设成今天，日期框会跟着变——用户能看见当前筛选条件是什么，
					// 而不是像以前那样切了 tab 但日期框还是空白，看着像没生效。
					h('div', { style: { display: 'flex', gap: '4px', marginTop: '10px' } },
						h('button', {
							type: 'button',
							style: Object.assign({}, pill, viewTab === 'all' ? S.tabOn : S.tabOff),
							onClick: () => { setViewTab('all'); setDay('') }
						}, '全部 ' + topics.length),
						h('button', {
							type: 'button',
							style: Object.assign({}, pill, viewTab === 'today' ? S.tabOn : S.tabOff),
							onClick: () => { setViewTab('today'); setDay(todayStr) }
						}, '今日 ' + todayCount)),
					// 筛选行：日期 / 赛道 / 来源 / 搜索 / 结果数
					h('div', { style: Object.assign({}, S.stageHead, { marginTop: '8px' }) },
						h('input', {
							type: 'date', value: day, style: sel2,
							min: days[0] || undefined, max: days[days.length - 1] || undefined,
							// 手动改日期时 tab 切回「全部」——否则 tab 显示「今日」但日期是别的日子，
							// 两个控件互相打架，用户看不出到底按哪个筛。
							onChange: (ev) => { setDay(ev.target.value); setViewTab('all') }
						}),
						day ? h('button', {
							style: Object.assign({}, pill, S.tabOff), type: 'button',
							onClick: () => { setDay(''); setViewTab('all') }
						}, '全部日期') : null,
						h('select', { style: sel2, value: track, onChange: (ev) => setTrack(ev.target.value) },
							h('option', { value: '全部' }, '全部赛道'),
							tracks.map((t) => h('option', { key: t, value: t }, t))),
						h('select', { style: sel2, value: src, onChange: (ev) => setSrc(ev.target.value) },
							h('option', { value: '全部' }, '全部来源'),
							srcs.map((t) => h('option', { key: t, value: t }, t))),
						h('input', {
							style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '240px' }),
							placeholder: '搜索标题、角度、来源…', value: q, onChange: (ev) => setQ(ev.target.value)
						}),
						h('span', { style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
							(track === '全部' ? '全部赛道' : track) + ' ' + list.length + ' 条选题'),
						note ? h('span', {
							style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }
						}, note) : null)),
				h('div', { style: S.body },
					props.error ? h('div', { style: S.err }, '数据层不可用：' + props.error) : null,
					waiting.length
						? h('div', { style: Object.assign({}, S.placeholder, { marginBottom: '12px' }) },
							'待分析 ' + waiting.length + ' 条：' + waiting.map((j) => j.title).join('、').slice(0, 90) + '…'
							+ ' —— 让 Agent 跑选题分析后，会在这里变成选题方案。')
						: null,
					topics.length === 0 && !props.loading
						? h('div', { style: S.placeholder }, '还没有选题方案。到「每日热榜」或「爆文库」点【入选题库】入队，再由 Agent 跑选题 skill 产出。')
						: !list.length
							? h('div', { style: S.placeholder }, '没有匹配的选题（共 ' + topics.length + ' 条）')
							: h('div', { style: Object.assign({}, S.grid, { gridTemplateColumns: 'repeat(auto-fill, minmax(336px, 1fr))' }) },
								list.map(card))),

				// 详情抽屉
				sel ? h('div', { style: S.drawer },
					h('button', { style: S.close, type: 'button', onClick: () => props.onOpen(null), title: '关闭' }, '✕'),
					h('div', { style: S.drawerHead },
						h('h2', { style: { margin: 0, fontSize: '16.5px', fontWeight: 650 } }, sel.title),
						h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
							h('span', { style: S.tag }, kindLabel[sel.kind] || sel.kind || '—'),
							h('span', { style: S.tag }, sel.persona || '通用'),
							h('span', { style: S.tag }, sel.track || '未设赛道'),
							h('span', { style: S.tag }, sel.skill || '未记技能'))),
					h('div', { style: S.drawerBody },

						// ── 新流程字段（2026-11-08 起）：方向 / 读者三问 / 四维评分 ──
						// 有新字段就优先显示新的——旧的 angle/hook/payoff 是模板拼接的套话，
						// 信息量远低于新流程产出的结构化内容。
						sel.topic_role ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '选题方向'),
							h('div', { style: S.doc }, sel.topic_role),
							sel.public_theme ? h('div', { style: Object.assign({}, S.doc, { marginTop: '6px', opacity: .85 }) },
								'公共命题：' + sel.public_theme) : null) : null,

						// 四维评分：一眼看出这个选题强在哪、弱在哪
						(() => {
							const dims = [
								['情绪势能', sel.score_emotion],
								['差异化', sel.score_difference],
								['受众基数', sel.score_audience],
								['时效窗口', sel.score_window],
							]
							const has = dims.some((x) => x[1] != null && x[1] > 0)
							if (!has) return null
							const passed = (sel.score_emotion >= 3 || sel.score_audience >= 3)
							const excellent = passed && sel.score_difference >= 3
							const verdict = excellent ? '优秀' : (passed ? '及格' : '不合格')
							const color = excellent ? '#1a7f37' : (passed ? '#b54708' : '#c0392b')

							const bar = (n, v) => h('span', {
								key: n,
								style: {
									width: '14px', height: '6px', borderRadius: '3px',
									background: n <= (v || 0)
										? 'var(--dsw-alias-label-primary)'
										: 'color-mix(in srgb, var(--dsw-alias-label-primary) 15%, transparent)'
								}
							})

							const row = (label, v) => h('div', {
								key: label, style: { display: 'flex', alignItems: 'center', gap: '8px' }
							},
								h('span', { style: { fontSize: '11.5px', width: '62px', color: 'var(--dsw-alias-label-secondary)' } }, label),
								h('span', { style: { display: 'flex', gap: '2px' } },
									[1, 2, 3, 4, 5].map((n) => bar(n, v))))

							return h('div', { style: S.block },
								h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
									h('div', { style: S.blockTitle }, '四维评分'),
									h('span', {
										style: Object.assign({}, S.tag, { color: color, borderColor: color, fontWeight: 650 })
									}, verdict)),
								h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '6px' } },
									dims.map((d) => row(d[0], d[1]))))
						})(),

						// 读者三问：这是新流程的核心，回答「为观众服务」
						(sel.reader_why_click || sel.reader_what_get || sel.reader_why_share) ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '读者三问'),
							[
								['为什么点开', sel.reader_why_click],
								['读完得到什么', sel.reader_what_get],
								['为什么会转发', sel.reader_why_share],
							].filter(([, v]) => v).map(([label, v]) => h('div', {
								key: label, style: { marginTop: '6px' }
							},
								h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, label),
								h('div', { style: S.doc }, v)))) : null,

						// 素材拆解：这条选题是从什么素材加工来的
						(() => {
							const facts = parseJson(sel.material_facts, [])
							const missing = parseJson(sel.material_missing, [])
							if (!facts.length && !missing.length) return null
							return h('div', { style: S.block },
								h('div', { style: S.blockTitle }, '素材拆解'),
								facts.length ? h('div', null,
									h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, '已知事实 ' + facts.length + ' 条'),
									h('div', { style: S.doc }, facts.map((f, k) => h('div', { key: 'f' + k }, '· ' + f)))) : null,
								missing.length ? h('div', { style: { marginTop: '8px' } },
									h('div', { style: { fontSize: '11px', color: '#b54708' } }, '缺口 ' + missing.length + ' 条（写作前要补）'),
									h('div', { style: S.doc }, missing.map((f, k) => h('div', { key: 'm' + k }, '· ' + f)))) : null)
						})(),

						// 旧字段兜底：没有新字段时才显示
						(!sel.topic_role && sel.angle) ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '切入角度'),
							h('div', { style: S.doc }, sel.angle)) : null,

						(!sel.reader_why_click && sel.hook) ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '为何可能点'),
							h('div', { style: S.doc }, sel.hook)) : null,

						(!sel.reader_what_get && sel.payoff) ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '兑现：正文必须提供什么'),
							h('div', { style: S.doc }, sel.payoff)) : null,

						// 候选标题：同样兼容「对象」与「纯字符串」两种元素格式
						parseJson(sel.titles_json, []).length ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '候选标题 ' + parseJson(sel.titles_json, []).length + ' 条'),
							h('div', null, parseJson(sel.titles_json, []).map((t, i) => {
								const isStr = typeof t === 'string'
								const text = isStr ? t : (t.title || '')
								const meta = isStr ? [] : [t.style ? '风格：' + t.style : '',
									t.formula ? '公式：' + t.formula : '',
									t.chars ? t.chars + ' 字' : '',
									t.payoff ? '兑现：' + t.payoff : ''].filter(Boolean)
								const isBest = isStr ? (text === sel.best_title)
									: (t.best || t.title === sel.best_title)
								return h('div', { key: 'ti' + i, style: i ? D.titleItem : null },
									h('div', { style: D.v },
										isBest ? h('span', { style: D.star }, '★ 首选 ') : null,
										text),
									meta.length ? h('div', { style: D.k }, meta.join(' · ')) : null)
							}))) : null,

						// 摘要候选
						parseJson(sel.digests_json, []).length ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '摘要候选'),
							h('div', null, parseJson(sel.digests_json, []).map((d, i) => h('div', { key: 'di' + i, style: i ? D.titleItem : null },
								h('div', { style: D.v }, typeof d === 'string' ? d : (d.text || JSON.stringify(d))))))) : null,

						// 大纲：元素可能是对象 {heading,words,gist}，也可能是纯字符串。
						// 两种都要渲染——早期数据存的是字符串数组，
						// 只按对象读会显示成一排空的「1. 2. 3.」（2026-11-08 修）
						parseJson(sel.outline_json, []).length ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '大纲预览'),
							h('div', null, parseJson(sel.outline_json, []).map((o, i) => {
								const line = (typeof o === 'string')
									? o
									: (o.heading || '') + (o.words ? '（' + o.words + ' 字）' : '')
										+ (o.gist ? '：' + o.gist : '')
								return h('div', { key: 'oi' + i, style: D.v }, (i + 1) + '. ' + line)
							}))) : null,

						// 工作量 / 素材
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '工作量与素材'),
							h('div', { style: D.v },
								[sel.word_count ? '预计 ' + sel.word_count + ' 字' : '',
									sel.effort ? '工作量 ' + sel.effort : '',
									sel.needs_material ? '需要额外素材：是' : '需要额外素材：否']
									.filter(Boolean).join(' · ') || '—')),

						// 来源热点
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '来源热点'),
							h('div', { style: D.v }, sel.source_title || '（无来源：手工添加的选题）'),
							sel.source_platform || sel.source_date || sel.source_hot
								? h('div', { style: D.k },
									[sel.source_platform || '', sel.source_date || '',
										sel.source_hot ? '热度 ' + fmtHot(sel.source_hot) : '']
										.filter(Boolean).join(' · '))
								: null,
							sel.source_url
								? h('a', {
									href: sel.source_url, target: '_blank', rel: 'noreferrer noopener',
									style: Object.assign({}, S.mono, { display: 'inline-block', marginTop: '4px' })
								}, '打开原文')
								: null,
							h('div', { style: Object.assign({}, D.k, { marginTop: '6px' }) },
								'素材 key：' + (sel.source_key || '—') + '｜job #' + (sel.job_id ?? '—'))),

						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '下一步'),
							h('button', {
								style: S.btn, type: 'button',
								onClick: () => props.onStatus(sel, sel.status === 'selected' ? 'candidate' : 'selected')
							}, sel.status === 'selected' ? '取消选定' : '选为写作'),
							h('div', { style: Object.assign({}, S.doc, { marginTop: '8px', fontSize: '11.5px' }) },
								'选定后打开「创作配置」，由你定主题、素材、观点与写作技能；点【开始创作】才真正动笔。'))
					)
				) : null
			)
		}

		// ── 全文阅读弹窗 ──
		// 稿件在宿主磁盘上，前端读不了，所以走 /api/workbench/draft-content 由 node 半读出来。
		// node 半优先返回 article.html（排版阶段的真产物）；没有就用 mdToHtml 现转。
		const ARTICLE_CSS = `
.wb-article { font-size: 15px; line-height: 1.95; color: var(--dsw-alias-label-primary); }
.wb-article h1 { font-size: 22px; line-height: 1.4; margin: 0 0 18px; font-weight: 700; }
.wb-article h2 { font-size: 18px; margin: 28px 0 12px; font-weight: 650; padding-left: 10px; border-left: 3px solid var(--dsw-alias-label-primary); }
.wb-article h3 { font-size: 16px; margin: 22px 0 10px; font-weight: 650; }
.wb-article p { margin: 0 0 16px; }
.wb-article strong { font-weight: 650; }
.wb-article blockquote { margin: 18px 0; padding: 12px 16px; border-left: 3px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); color: var(--dsw-alias-label-secondary); }
.wb-article blockquote p { margin: 0; }
.wb-article ul { margin: 0 0 16px; padding-left: 22px; }
.wb-article li { margin: 6px 0; }
.wb-article figure.wb-ph { margin: 18px 0; }
.wb-article .wb-ph-box { height: 84px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px;
  display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wb-article figcaption { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: center; }
.wb-article .wb-cap { display: block; opacity: .8; }
.wb-article img { max-width: 100%; }
/* 创作进度条的「进行中」呼吸动画：只改透明度，不动布局，避免重排 */
@keyframes dswWbPulse {
  0%, 100% { opacity: .35; }
  50% { opacity: 1; }
}
`

		function TextPreview(props) {
			const [mode, setMode] = React.useState('render')      // render | source
			const M = {
				overlay: {
					position: 'fixed', inset: 0, background: 'rgba(0,0,0,.38)', zIndex: 9999,
					display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px'
				},
				box: {
					width: '760px', maxWidth: '100%', height: '86vh', display: 'flex', flexDirection: 'column',
					background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '14px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', boxShadow: '0 18px 48px rgba(0,0,0,.22)',
					color: 'var(--dsw-alias-label-primary)'
				},
				head: { padding: '14px 18px 12px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', display: 'flex', alignItems: 'center', gap: '10px' },
				title: { fontSize: '15.5px', fontWeight: 650, flex: '1 1 auto' },
				meta: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
				seg: { display: 'flex', gap: '0', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '8px', overflow: 'hidden' },
				segOn: { padding: '4px 12px', font: 'inherit', fontSize: '12px', cursor: 'pointer', border: 0, background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)' },
				segOff: { padding: '4px 12px', font: 'inherit', fontSize: '12px', cursor: 'pointer', border: 0, background: 'transparent', color: 'inherit' },
				body: { flex: '1 1 auto', overflow: 'auto', padding: '20px 26px' },
				pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: '12.5px/1.8 ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--dsw-alias-label-secondary)' },
				foot: { padding: '10px 18px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', display: 'flex', justifyContent: 'flex-end', gap: '8px' },
				btn: { padding: '7px 16px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
				primary: { padding: '7px 18px', borderRadius: '8px', border: '1px solid var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)', font: 'inherit', fontWeight: 600, cursor: 'pointer' }
			}
			const ready = !props.loading && !props.error
			return h('div', {
				style: M.overlay,
				onClick: (ev) => { if (ev.target === ev.currentTarget) props.onClose() }
			},
				h('div', { style: M.box },
					h('style', null, ARTICLE_CSS),
					h('div', { style: M.head },
						h('div', { style: M.title }, props.title || '全文'),
						props.file
							? h('div', { style: M.meta },
								mode === 'source' && props.sourceFile ? props.sourceFile : props.file)
							: null,
						ready ? h('div', { style: M.seg },
							h('button', {
								style: mode === 'render' ? M.segOn : M.segOff, type: 'button',
								onClick: () => setMode('render')
							}, '排版'),
							h('button', {
								style: mode === 'source' ? M.segOn : M.segOff, type: 'button',
								onClick: () => setMode('source')
							}, '源码')) : null),
					h('div', { style: M.body },
						props.loading
							? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '正在读取…')
							: props.error
								? h('div', { style: S.err }, props.error)
								: mode === 'source'
									? h('pre', { style: M.pre },
										props.text || '（这篇没有 markdown 源文件，只有排版产物 article.html）')
									: h('div', {
										className: 'wb-article',
										dangerouslySetInnerHTML: { __html: props.html || '' }
									})),
					h('div', { style: M.foot },
						h('button', {
							style: M.primary, type: 'button', disabled: props.loading || !!props.error,
							onClick: () => copyRich(props.html || '', props.text || '',
								(msg) => props.onToast(msg || '已复制带格式正文，可直接粘贴到公众号编辑器'),
								(msg) => props.onToast(msg))
						}, '复制到公众号'),
						h('button', {
							style: M.btn, type: 'button',
							onClick: () => {
								const t = props.text || ''
								if (!t) { props.onToast('没有源码可复制（这篇只有排版产物）'); return }
								copyText(t, () => props.onToast('已复制 markdown 源码'))
							}
						}, '复制源码'),
						h('button', { style: M.btn, type: 'button', onClick: props.onClose }, '关闭')))
			)
		}

		// ── 创作库：列表 + 详情抽屉 + 阶段推进 ──
		// 说明：封面是宿主上的文件路径，前端不能直接读，所以列表里只做一个占位标记，
		// 路径在详情抽屉里显示（将来走 /api/file 之类的文件路由再渲染缩略图）。
		// ── 创作配置抽屉 ──
		// 这个组件是整个「不全自动」改造的核心：它把「写什么」和「怎么写」显式摊开，
		// 用户不点「开始创作」就什么都不会发生。
		//
		// 为什么是抽屉不是弹窗：配置项有 7 组，弹窗会溢出；抽屉能贴右侧滚动，
		// 而且填配置时还能看到左边的列表。
		//
		// preset 来自选题库（选为写作带入），也可能为空（手工新建）。
		function DraftConfig(props) {
			const preset = props.preset || {}
			const [form, setForm] = React.useState(() => ({
				theme: preset.theme || '',
				materials: preset.materials || '',
				requirement: preset.requirement || '',
				// 文章骨架：Agent 在「出骨架」阶段生成后回填，也可人手填。
				// 存下来是为了让后续阶段（写正文、审稿）都对着同一份骨架走。
				skeleton: preset.config && preset.config.skeleton ? preset.config.skeleton : '',
				// 选题的切入角度：只作为「个人观点」的可选参考，不自动写入
				angle: preset.angle || '',
				skill: preset.skill || WRITABLE_SKILLS[0].name,
				// 改配置时把上次选的字数/风格带回来，否则重开抽屉会被重置成默认
				wordKey: preset.config && preset.config.wordKey ? preset.config.wordKey : 'medium',
				words: preset.config && preset.config.words ? preset.config.words : 1350,
				// 风格库的 code（如 MS-006）。空串 = 不用风格。
				styleCode: preset.config && preset.config.styleCode ? preset.config.styleCode : '',
				styleKind: preset.config && preset.config.styleKind ? preset.config.styleKind : '',
				genre: preset.genre || AUTO_GENRE,
				title: preset.title || ''
			}))
			const [busy, setBusy] = React.useState(false)
			const [showMaterials, setShowMaterials] = React.useState(!!preset.materials)
			const [showSkeleton, setShowSkeleton] = React.useState(
				!!(preset.config && preset.config.skeleton))
			// 素材 <300 字视为偏薄：骨架第②步「吃透素材」需要足够事实，
			// 否则 Agent 只能编，或者只能写空话。
			const matThin = form.materials.trim().length < 300
			const set = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

			// 风格库：从数据层拉，按赛道优先排序
			const [styleList, setStyleList] = React.useState([])
			// 风格选择区按「个人 / 系统」分 tab，与「风格库」页的组织保持一致。
			// 默认停在已选风格所属的那个 tab；没选过就停在「系统」。
			const [styleTab, setStyleTab] = React.useState(
				preset.config && preset.config.styleKind === 'personal' ? '个人' : '系统')
			const [styleLoading, setStyleLoading] = React.useState(true)
			React.useEffect(() => {
				let alive = true
				apiGet('/api/workbench/styles?kind=all')
					.then((d) => { if (alive) setStyleList(d.styles || []) })
					.catch(() => { if (alive) setStyleList([]) })
					.finally(() => { if (alive) setStyleLoading(false) })
				return () => { alive = false }
			}, [])

			const wordPreset = WORD_PRESETS.find((w) => w.key === form.wordKey)
			const curSkill = WRITING_SKILLS.find((s) => s.name === form.skill) || WRITABLE_SKILLS[0]
			const curStyle = styleList.find((s) => s.code === form.styleCode) || null
			// 技能与风格是否配套。不配套时给提示，而不是替用户改——
			// 用户可能有正当理由（比如用 aws 的技能骨架、卡兹克的语气）。
			const styleMismatch = (() => {
				const want = curSkill.defaultStyle
				if (!want || !form.styleCode || form.styleCode === want) return null
				const wantStyle = styleList.find((x) => x.code === want)
				if (!wantStyle) return null
				const klassDiff = (wantStyle.track === curSkill.hint ? '' : '')
				let why = ''
				if (curSkill.klass === 'A' && wantStyle.name.indexOf('卡兹克') >= 0) {
					why = 'A 类技能要过 aws 加粗配额，而卡兹克体禁加粗，两边会打架。'
				} else if (curSkill.klass !== 'A') {
					why = '风格与技能类型不一致，检查器可能按技能那一套去卡。'
				}
				return { wantName: wantStyle.name, curName: curStyle ? curStyle.name : form.styleCode, why: why }
			})()
			// 适用赛道相同的排前面；其余保持后端顺序（used_count 降序）
			const sortedStyles = React.useMemo(() => {
				const g = form.genre
				return styleList.slice().sort((a, b) => {
					const am = a.track && g && a.track === g ? 0 : 1
					const bm = b.track && g && b.track === g ? 0 : 1
					return am - bm
				})
			}, [styleList, form.genre])
			// 当前 tab 下要显示的风格
			const tabStyles = sortedStyles.filter((s) => (s.kind === 'personal' ? '个人' : '系统') === styleTab)
			const countOf = (t) => sortedStyles.filter((s) => (s.kind === 'personal' ? '个人' : '系统') === t).length

			const M = {
				overlay: {
					// 不贴边：四周留 24px，垂直居中。原来是 justifyContent:'flex-end'
					// + box 高度 100%，顶部会顶到应用标题栏，X 和窗口关闭键重合，
					// 用户点 X 把整个软件关了（2026-11-08 修）。
					position: 'fixed', inset: 0, background: 'rgba(0,0,0,.32)', zIndex: 9998,
					display: 'flex', alignItems: 'center', justifyContent: 'center',
					padding: '24px', boxSizing: 'border-box'
				},
				box: {
					// 居中浮层：四周边框 + 圆角 + 居中投影。
					// 原来的 borderLeft / -16px 阴影是抽屉式（靠右贴边）的写法，
					// 改成居中后必须换成全边框 + 居中投影，否则左边框和阴影方向都是错的。
					width: '560px', maxWidth: '100%',
					maxHeight: '100%', height: 'auto',
					display: 'flex', flexDirection: 'column',
					borderRadius: '14px', overflow: 'hidden',
					background: 'var(--dsw-alias-bg-layer-1)',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					boxShadow: '0 18px 48px rgba(0,0,0,.22)',
					color: 'var(--dsw-alias-label-primary)'
				},
				head: { padding: '16px 20px 12px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
				title: { fontSize: '15.5px', fontWeight: 650 },
				sub: { marginTop: '5px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.6' },
				body: { flex: '1 1 auto', overflow: 'auto', padding: '14px 20px 20px', display: 'flex', flexDirection: 'column', gap: '16px' },
				group: { display: 'flex', flexDirection: 'column', gap: '7px' },
				label: { fontSize: '12.5px', fontWeight: 600 },
				labelRow: { display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' },
				input: {
					width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'var(--dsw-alias-bg-layer-2, transparent)',
					color: 'inherit', font: 'inherit', outline: 'none'
				},
				area: {
					width: '100%', boxSizing: 'border-box', minHeight: '80px', resize: 'vertical',
					padding: '8px 10px', borderRadius: '8px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'var(--dsw-alias-bg-layer-2, transparent)',
					color: 'inherit', font: 'inherit', outline: 'none', lineHeight: '1.65'
				},
				hint: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.6' },
				chips: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
				chip: {
					padding: '5px 12px', borderRadius: '8px', cursor: 'pointer', font: 'inherit',
					fontSize: '12.5px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'transparent', color: 'var(--dsw-alias-label-secondary)'
				},
				chipOn: {
					border: '1px solid var(--dsw-alias-label-primary)',
					color: 'var(--dsw-alias-label-primary)', fontWeight: 600
				},
				card: {
					textAlign: 'left', padding: '9px 11px', borderRadius: '9px', cursor: 'pointer',
					font: 'inherit', display: 'flex', flexDirection: 'column', gap: '3px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'transparent', color: 'inherit'
				},
				cardOn: {
					border: '1px solid var(--dsw-alias-label-primary)',
					background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)'
				},
				cardTitle: { fontSize: '12.5px', fontWeight: 600 },
				cardHint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.5' },
				mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' },
				counter: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' },
				mini: {
					alignSelf: 'flex-start', fontSize: '11.5px', padding: '4px 9px',
					borderRadius: '7px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
					cursor: 'pointer', marginBottom: '6px'
				},
				slider: { width: '100%', margin: '2px 0' },
				fold: {
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '9px',
					padding: '9px 11px', cursor: 'pointer', background: 'transparent',
					color: 'inherit', font: 'inherit', textAlign: 'left', display: 'flex',
					alignItems: 'center', gap: '6px', fontSize: '12.5px'
				},
				foot: {
					padding: '12px 20px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto'
				},
				btn: {
					padding: '8px 16px', borderRadius: '9px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer'
				},
				primary: {
					padding: '8px 20px', borderRadius: '9px',
					border: '1px solid var(--dsw-alias-label-primary)',
					background: 'var(--dsw-alias-label-primary)',
					color: 'var(--dsw-alias-bg-layer-1)', font: 'inherit', fontWeight: 600, cursor: 'pointer'
				},
				primaryOff: {
					padding: '8px 20px', borderRadius: '9px',
					border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
					background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
					font: 'inherit', cursor: 'default'
				}
			}

			// 骨架第③步要角度，所以核心角度也纳入必填。
			const canStart = form.theme.trim().length > 0 && form.requirement.trim().length > 0 && !busy
			const matLen = form.materials.length

			// 提交：把选中风格的完整 Markdown 一起带走。
			// 为什么带全文而不只带 code：风格可能被改或归档，草稿要能复现当时的写法。
			const submit = async () => {
				if (!canStart) return
				if (typeof props.onStart !== 'function') {
					// 挂载处传的是 onStart（不是 onSubmit）。写错名字会静默无反应，
					// 所以这里显式报错，别让它装成「一切正常」。
					window.alert('内部错误：创作配置没有接上提交回调 onStart')
					return
				}
				setBusy(true)
				try {
					await props.onStart({
						draftId: preset.draftId || null,
						theme: form.theme.trim(),
						materials: form.materials.trim(),
						requirement: form.requirement.trim(),
						skill: form.skill,
						skillClass: curSkill.klass,
						title: form.title.trim() || form.theme.trim().slice(0, 40),
						genre: form.genre === AUTO_GENRE ? '' : form.genre,
						config: {
							words: form.words,
							wordKey: form.wordKey,
							styleCode: form.styleCode,
							styleName: curStyle ? curStyle.name : '',
							styleKind: curStyle ? curStyle.kind : '',
							skeleton: form.skeleton.trim(),
							styleBody: curStyle ? (curStyle.body_md || '') : ''
						}
					})
				} finally {
					setBusy(false)
				}
			}

			return h('div', { style: M.overlay },
				h('div', { style: M.box },
					h('div', { style: M.head },
						h('div', { style: M.title },
							preset.draftId ? '创作配置 · 改已有稿'
								: preset.topicId ? '创作配置 · 来自选题' : '创作配置'),
						h('div', { style: M.sub },
							preset.draftId
								? '这是在改一篇还没开写的稿。点「开始创作」按新配置重写，不会新建第二条。'
								: preset.topicId
									? '已把选题的主题、素材与观点带入下面。改完点「开始创作」才会真正写。'
									: '选技能与风格，填主题，点「开始创作」才会真正写。')),

					h('div', { style: M.body },
						// ── ① 写作技能 ──
						h('div', { style: M.group },
							h('div', { style: M.label }, '写作技能'),
							h('div', { style: M.chips },
								WRITING_SKILLS.map((s) => h('button', {
									key: s.name, type: 'button',
									style: Object.assign({}, M.chip, form.skill === s.name ? M.chipOn : null),
									title: s.hint,
									onClick: () => {
										// 切技能时联动默认风格：技能与风格同源，成套用才不出错。
										// 只在该技能声明了 defaultStyle 且库里真有这个风格时才切。
										const want = s.defaultStyle
										const has = want && styleList.some((x) => x.code === want)
										setForm((f) => Object.assign({}, f, {
											skill: s.name,
											...(has ? { styleCode: want } : {})
										}))
										if (has) {
											const sd = styleList.find((x) => x.code === want)
											if (props.onToast) props.onToast('已按技能自动选风格：' + (sd ? sd.name : want))
										}
									}
								}, s.title + ' · ' + s.klass))),
							h('div', { style: M.hint },
								h('span', { style: M.mono }, curSkill.name),
								' ｜ ' + curSkill.hint)),

						// ── ② 创作风格（接风格库）──
						h('div', { style: M.group },
							h('div', { style: M.labelRow },
								h('div', { style: M.label }, '创作风格'),
								h('div', { style: M.counter }, styleLoading ? '读取中…' : (sortedStyles.length + ' 个可选'))),
							h('div', { style: M.hint },
								'风格是一份完整的写作提示词，选中后会把全文送进写作指令。不选则按技能默认。'),
							styleLoading
								? h('div', { style: M.hint }, '正在读取风格库…')
								: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
									// tab 切换：个人 / 系统。带各自数量，一眼看出哪个库里有东西。
									h('div', { style: M.chips },
										['个人', '系统'].map((t) => h('button', {
											key: t, type: 'button',
											style: Object.assign({}, M.chip, styleTab === t ? M.chipOn : null),
											onClick: () => setStyleTab(t)
										}, t + '（' + countOf(t) + '）'))),
									tabStyles.length === 0
										? h('div', { style: M.hint },
											styleTab === '个人'
												? '还没有自建风格。到「风格库」→「个人」建一份，或切到「系统」用内置的。'
												: '系统库里没有风格。')
										: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px', maxHeight: '230px', overflowY: 'auto' } },
											// 「不用风格」只挂在系统 tab 的第一格，避免两个 tab 各出现一次
											(styleTab === '系统' ? [
												h('button', {
													key: '__none__', type: 'button',
													style: Object.assign({}, M.card, !form.styleCode ? M.cardOn : null),
													onClick: () => set('styleCode', '')
												},
													h('div', { style: M.cardTitle }, '不用风格'),
													h('div', { style: M.cardHint }, '按写作技能的默认语气写'))
											] : []).concat(tabStyles.map((s) => h('button', {
												key: s.code, type: 'button',
												style: Object.assign({}, M.card, form.styleCode === s.code ? M.cardOn : null),
												title: s.desc || '',
												onClick: () => {
													set('styleCode', s.code)
													// 顺手记住 kind，下次打开配置能停回正确的 tab
													setForm((f) => Object.assign({}, f, { styleKind: s.kind }))
												}
											},
												h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px' } },
													h('span', { style: M.cardTitle }, s.name),
													s.kind === 'system' ? h('span', { style: Object.assign({}, M.mono, { marginLeft: 'auto' }) }, '内置') : null),
												h('div', { style: M.cardHint }, s.desc || '暂无描述'),
												s.track ? h('div', { style: Object.assign({}, M.mono, { marginTop: '2px' }) }, s.track) : null))))),
							curStyle ? h('div', { style: M.hint },
								'已选 ' + curStyle.code + '｜正文 ' + (curStyle.body_md || '').length + ' 字符，写作时整份送进指令。') : null,
							// 技能与风格不配套时提示（不阻止，只提醒）。
							// 典型冲突：A 类技能要求每 100 字一处加粗，而卡兹克体禁加粗。
							styleMismatch ? h('div', {
								style: {
									fontSize: '11.5px', lineHeight: '1.6', padding: '7px 9px', borderRadius: '7px',
									color: '#b54708', background: 'color-mix(in srgb, #b54708 8%, transparent)'
								}
							}, '⚠ 当前技能「' + curSkill.title + '」推荐用风格「' + styleMismatch.wantName +
								'」，你选的是「' + styleMismatch.curName + '」。'
								+ styleMismatch.why + '　可以继续，但检查器会按技能的尺子卡。') : null),

						// ── ③ 主题 ──
						h('div', { style: M.group },
							h('div', { style: M.label }, '主题 *'),
							h('textarea', {
								style: Object.assign({}, M.area, { minHeight: '70px' }),
								value: form.theme,
								placeholder: '你想写什么？输入主题或核心观点…',
								onChange: (ev) => set('theme', ev.target.value)
							}),
							h('div', { style: M.hint }, '必填。一句话说清写什么即可，Agent 会按它定角度。')),

						// ── ④ 参考素材（可选，折叠）──
						h('div', { style: M.group },
							h('button', {
								style: M.fold, type: 'button',
								onClick: () => setShowMaterials((v) => !v)
							}, (showMaterials ? '▾ ' : '▸ ') + '参考素材（骨架第②步）',
								form.materials
									? h('span', { style: { fontSize: '11px', color: matThin ? '#b54708' : 'var(--dsw-alias-label-secondary)' } },
										(matThin ? '⚠ 仅 ' : '') + matLen + ' 字')
									: h('span', { style: { fontSize: '11px', color: '#b54708' } }, '⚠ 未填')),
							showMaterials ? h('div', { style: M.group },
								h('div', { style: M.hint },
									'把正文复制粘贴进来。输入网址无法识别，需要自己打开链接复制内容。'),
								matThin ? h('div', {
									style: {
										fontSize: '11.5px', lineHeight: '1.6', padding: '7px 9px', borderRadius: '7px',
										color: '#b54708', background: 'color-mix(in srgb, #b54708 8%, transparent)'
									}
								}, '素材偏薄（' + matLen + ' 字，建议 ≥300）。骨架第②步「吃透素材」需要足够的事实：'
									+ '时间、数字、原话、动作。素材不够时 Agent 只能编，或者只能写空话。'
									+ '可以先补素材，或在生成时要求它联网查证。') : null,
								h('textarea', {
									style: M.area, value: form.materials, maxLength: 5000,
									placeholder: '请复制正文文本粘贴到此处…',
									onChange: (ev) => set('materials', ev.target.value)
								}),
								h('div', { style: Object.assign({}, M.hint, { textAlign: 'right' }) },
									matLen + ' / 5000')
							) : null),

						// ── ⑤ 核心角度（必填，骨架第③步）──
						// 为什么从「个人观点（可选）」改成「核心角度 *」：
						// 原措辞问的是「你想要什么立场」，用户答的多是「这事挺有意思」，
						// 够不上技能要的「主角度一句话」。骨架第③步定角度需要的是一个
						// 可验证的命题：读完这篇读者会多知道什么。
						h('div', { style: M.group },
							h('div', { style: M.label }, '核心角度 *'),
							form.angle && !form.requirement ? h('button', {
								style: M.mini, type: 'button',
								onClick: () => set('requirement', form.angle)
							}, '采用选题角度（' + form.angle.slice(0, 18) + '…）') : null,
							h('textarea', {
								style: Object.assign({}, M.area, { minHeight: '64px' }), value: form.requirement,
								placeholder: '一句话说清：你想让读者记住什么？例如：主力缺席时，真正被考的不是能不能赢，是领先之后能不能不慌',
								onChange: (ev) => set('requirement', ev.target.value)
							}),
							h('div', { style: M.hint },
								form.requirement.trim()
									? '会作为文章的立场主线，一路传到写作、审稿与定稿。'
									: '必填。这是骨架第③步的输入——没有它，Agent 会自己编一个角度，或者写成流水账。')),

						// ── ⑥ 文章骨架（骨架第④步，可留空由 Agent 生成）──
						h('div', { style: M.group },
							h('button', {
								style: M.fold, type: 'button',
								onClick: () => setShowSkeleton((v) => !v)
							}, (showSkeleton ? '▾ ' : '▸ ') + '文章骨架（可留空，Agent 会先出骨架给你确认）',
								form.skeleton ? h('span', { style: M.counter }, '已填') : null),
							showSkeleton ? h('div', { style: M.group },
								h('div', { style: M.hint },
									'留空 = Agent 在「出骨架」阶段先给你一份大纲，确认后再写正文。'
									+ '已有想法可直接写在这里，会跳过生成、直接按它写。'),
								h('textarea', {
									style: Object.assign({}, M.area, { minHeight: '96px' }), value: form.skeleton,
									placeholder: '每行一个推进节点，例如：\n1. 男团 3-0 拿下，干净\n2. 女团 2-3 输日本，首盘就掉分\n3. 两块银牌都是领先过的\n4. 这批年轻人差在哪',
									onChange: (ev) => set('skeleton', ev.target.value)
								})) : null),

						// ── ⑥ 字数控制 ──
						h('div', { style: M.group },
							h('div', { style: M.labelRow },
								h('div', { style: M.label }, '字数控制'),
								h('div', { style: M.counter }, '当前：' + (wordPreset ? wordPreset.min + '~' + wordPreset.max : form.words) + ' 字')),
							h('div', { style: M.chips },
								WORD_PRESETS.map((w) => h('button', {
									key: w.key, type: 'button',
									style: Object.assign({}, M.chip, form.wordKey === w.key ? M.chipOn : null),
									onClick: () => setForm((f) => Object.assign({}, f, {
										wordKey: w.key, words: Math.round((w.min + w.max) / 2)
									}))
								}, w.label + ' ' + w.min + '~' + w.max))),
							h('input', {
								style: M.slider, type: 'range', min: 100, max: 10000, step: 100,
								value: form.words,
								onChange: (ev) => setForm((f) => Object.assign({}, f, {
									words: Number(ev.target.value), wordKey: 'custom'
								}))
							}),
							h('div', { style: M.hint }, '目标 ' + form.words + ' 字。拖滑杆可越过三档微调。'))),

					h('div', { style: M.foot },
						h('div', { style: Object.assign({}, M.hint, { marginRight: 'auto' }) },
							'生成后可预览、编辑并自动保存'),
						h('button', { style: M.btn, type: 'button', disabled: busy, onClick: props.onClose }, '取消'),
						h('button', {
							style: canStart ? M.primary : M.primaryOff,
							type: 'button', disabled: !canStart, onClick: submit
						}, busy ? '正在提交…' : '开始创作')))
			)
		}

		// ── 文字风格库 ────────────────────────────────────────────────
		// 与生图工作台那个「风格库」不是一回事：那是图片画风（handraw 367 个），
		// 这是**文字语气**，是写作技能之下的变体。所以两个模块同名但不同维度。
		function StyleLibrary(props) {
			const onToast = props.onToast || (() => {})
			const [tab, setTab] = React.useState('系统')
			const [q, setQ] = React.useState('')
			const [styles, setStyles] = React.useState([])
			const [loading, setLoading] = React.useState(true)
			const [err, setErr] = React.useState('')
			const [editing, setEditing] = React.useState(null)   // null | {} 新建 | 风格对象 编辑
			const [preview, setPreview] = React.useState(null)
   // 展开看指标与样本

			const KIND = { 个人: 'personal', 系统: 'system' }

			const reload = React.useCallback(async () => {
				try {
					const data = await apiGet('/api/workbench/styles?kind=' + KIND[tab])
					setStyles(data.styles || [])
					setErr('')
				} catch (e) {
					setErr(String((e && e.message) || e))
				} finally {
					setLoading(false)
				}
			}, [tab])

			React.useEffect(() => { setLoading(true); reload() }, [reload])

		 const list = styles.filter((s) => {
				if (!q.trim()) return true
				const hay = (s.name + ' ' + (s.desc || '') + ' ' + (s.track || '')).toLowerCase()
				return hay.includes(q.trim().toLowerCase())
			})

			const vote = async (s, up) => {
				try {
					await apiPost('/api/workbench/styles', { action: 'vote', code: s.code, up })
					reload()
				} catch (e) { onToast('投票失败：' + ((e && e.message) || e)) }
			}

			const remove = async (s) => {
				if (!window.confirm('归档风格「' + s.name + '」？归档后不再出现在列表里，已有草稿不受影响。')) return
				try {
					await apiPost('/api/workbench/styles', { action: 'delete', code: s.code })
					onToast('已归档')
					reload()
				} catch (e) { onToast('归档失败：' + ((e && e.message) || e)) }
			}

			const D = {
				headRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
				tabWrap: { display: 'flex', gap: '2px', padding: '3px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
				tabOn: { padding: '4px 14px', borderRadius: '999px', border: 0, cursor: 'pointer', font: 'inherit', fontSize: '12.5px', fontWeight: 600, background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)' },
				tabOff: { padding: '4px 14px', borderRadius: '999px', border: 0, cursor: 'pointer', font: 'inherit', fontSize: '12.5px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
				search: { marginLeft: 'auto', width: '260px', boxSizing: 'border-box', padding: '7px 12px', borderRadius: '9px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', outline: 'none' },
				grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '14px', marginTop: '14px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)', borderRadius: '14px', padding: '14px' },
				card: { position: 'relative', textAlign: 'left', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '14px', padding: '16px', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '176px' },
				newCard: { textAlign: 'center', border: '1px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '14px', padding: '20px 16px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent)', color: 'inherit', font: 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', minHeight: '176px' },
				plus: { width: '46px', height: '46px', borderRadius: '999px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', border: '2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
				dot: { width: '9px', height: '9px', borderRadius: '999px', background: '#6fae2f', display: 'inline-block', flex: '0 0 auto' },
				name: { fontSize: '17px', fontWeight: 700, letterSpacing: '-0.01em' },
				badge: { fontSize: '10.5px', padding: '1px 7px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
				desc: { fontSize: '12.5px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '40px' },
				foot: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: 'auto', paddingTop: '10px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
				iconBtn: { border: 0, background: 'transparent', cursor: 'pointer', font: 'inherit', fontSize: '15px', padding: '2px 4px', color: 'var(--dsw-alias-label-secondary)', borderRadius: '6px' },
				ver: { fontSize: '10.5px', padding: '1px 7px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', color: 'var(--dsw-alias-label-secondary)' },
				empty: { padding: '40px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '12.5px' }
			}

			// 展开面板：直接把那份 Markdown 原样显示出来。
			// 不做 Markdown 渲染是**故意的**——用户要看到的就是「将来喂给模型的那段原文」，
			// 渲染成富文本反而看不出它的实际边界和格式。
			const detail = (s) => {
				const body = s.body_md || ''
				return h('div', { style: { marginTop: '4px', borderTop: '1px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', paddingTop: '8px' } },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
						h('span', { style: { fontSize: '11px', fontWeight: 700, color: 'var(--dsw-alias-label-secondary)' } },
							'风格提示词 ' + body.length + ' 字符'),
						h('button', {
							type: 'button', style: Object.assign({}, S.mini, { marginLeft: 'auto' }),
							onClick: () => copyText(body, () => onToast('已复制到剪贴板'))
						}, '复制')),
					body
						? h('pre', {
							style: {
								margin: 0, padding: '10px 12px', borderRadius: '8px', maxHeight: '320px', overflowY: 'auto',
								whiteSpace: 'pre-wrap', wordBreak: 'break-word',
								fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', lineHeight: '1.7',
								background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)'
							}
						}, body)
						: h('div', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } }, '（还没有正文，点「编辑」填一份）'))
			}

			const card = (s) => h('div', { key: s.code, style: D.card },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
					h('span', { style: D.dot }),
					h('span', { style: D.name }, s.name),
					s.kind === 'system' ? h('span', { style: D.badge }, '内置') : null,
					s.used_count > 0 ? h('span', { style: D.badge }, '用过 ' + s.used_count + ' 次') : null,
					h('span', { style: Object.assign({}, D.ver, { marginLeft: 'auto' }) }, 'v' + (s.version || 1))),
				h('div', { style: D.desc }, s.desc || '暂无描述'),
				s.track ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, '适用：' + s.track) : null,
				h('div', { style: D.foot },
					h('button', { type: 'button', style: D.iconBtn, title: '有用', onClick: () => vote(s, true) }, '👍' + (s.upvotes || '')),
					h('button', { type: 'button', style: D.iconBtn, title: '没用', onClick: () => vote(s, false) }, '👎' + (s.downvotes || '')),
					h('button', {
						type: 'button', style: Object.assign({}, S.mini, { marginLeft: 'auto' }),
						onClick: () => setPreview(preview === s.code ? null : s.code)
					}, preview === s.code ? '收起' : '指标'),
					h('button', { type: 'button', style: S.mini, onClick: () => setEditing(s) }, '编辑'),
					s.kind === 'personal' ? h('button', {
						type: 'button', style: Object.assign({}, S.mini, { color: '#b42318' }),
						onClick: () => remove(s)
					}, '归档') : null),
				preview === s.code ? detail(s) : null)

			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto', position: 'relative' } },
				h('div', { style: S.head },
					h('div', { style: D.headRow },
						h('h1', { style: S.h1 }, '文字风格库'),
						h('div', { style: D.tabWrap },
							['个人', '系统'].map((t) => h('button', {
								key: t, type: 'button', style: tab === t ? D.tabOn : D.tabOff,
								onClick: () => { setTab(t); setPreview(null) }
							}, t))),
						h('input', {
							style: D.search, value: q, placeholder: '搜索风格…',
							onChange: (ev) => setQ(ev.target.value)
						})),
					h('p', { style: S.sub },
						'同一写作技能下的语气变体。风格是一组可测量指标 + 禁用项，不是形容词——写完能机器验收。' +
						'　当前 ' + list.length + ' 个')),

				h('div', { style: S.body },
					err ? h('div', { style: S.err }, err) : null,
					loading ? h('div', { style: D.empty }, '正在读取…')
						: h('div', { style: D.grid },
							tab === '个人' ? h('button', {
								type: 'button', style: D.newCard, onClick: () => setEditing({})
							},
								h('div', { style: D.plus }, '+'),
								h('div', { style: { fontSize: '16px', fontWeight: 700 } }, '创建新风格'),
								h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.6' } },
									'定一组指标与禁用项，让稿子的语气可验收')) : null,
							list.map(card))),

				editing ? h(StyleEditor, {
					style: editing, onClose: () => setEditing(null),
					onSaved: (msg) => { onToast(msg); setEditing(null); reload() }
				}) : null)
		}

		// ── 风格编辑：一个大 Markdown 编辑框 ─────────────────────────
		// 为什么不拆成「画像/词库/范文/指标」四段表单（2026-11-05 改）：
		//   风格提示词的最终消费者是写作模型，它读的就是一段文本。
		//   拆成字段存、用的时候再拼回去，中间每一步都可能丢信息，
		//   而且用户看不见整体、也没法一键复制走。
		//   一份提示词从 5 行到 50 行都可能，表单会逼人按格子填。
		const STYLE_TEMPLATE = [
			'## 人格定位',
			'',
			'这是什么样的人，用什么姿态写，和读者什么关系。',
			'',
			'## 语言特征',
			'',
			'- **句式节奏**：句子长短，平均多少字，有没有标志性句式',
			'- **用词倾向**：口语/书面/网络用语的比例，个人高频词',
			'- **标点习惯**：省略号、感叹号、问号怎么用，有没有非常规用法',
			'- **情绪表达**：情绪怎么传递，克制还是外放',
			'',
			'## 口语词组库',
			'',
			'> 必须从原文逐字提取，禁止编造或归纳改写。某类没有就留空，不要凑数。',
			'',
			'- **转场过渡**：',
			'- **表达判断**：',
			'- **承认自嘲**：',
			'- **情绪表达**：',
			'- **拉近读者**：',
			'',
			'## 写法特征',
			'',
			'- **开篇方式**：怎么起第一句',
			'- **论述推进**：怎么展开，有没有一轮比一轮更强',
			'- **知识引入**：随手嵌入叙事，还是停下来专门讲',
			'- **论述打破**：中间是否跑题、自嘲、吐槽来打断节奏',
			'- **收束方式**：升华，还是戛然而止',
			'',
			'## 禁忌清单',
			'',
			'这个风格绝对不会怎么写。比禁用词宽——是写法层面的禁令。',
			'',
			'- ',
			'',
			'## 可测量指标',
			'',
			'这一节是**能机器验收**的部分，写完拿它跑一遍，越界就报。',
			'',
			'| 指标 | 区间 | 说明 |',
			'|---|---|---|',
			'| 平均句长 | 16-22 | 最灵敏的一个数 |',
			'| 段落句数 | 2-4 | 超过 5 句就拆 |',
			'| 第二人称密度 | 8-15 /千字 | 低于 8 就变资讯稿 |',
			'',
			'## 范文摘录',
			'',
			'> 从原文逐字摘录，不可改写。这段会作为 few-shot 锚点——比十条指标都管用。',
			'',
			''
		].join('\n')

		function StyleEditor(props) {
			const s = props.style || {}
			const isNew = !s.code
			const [f, setF] = React.useState({
				name: s.name || '', desc: s.desc || '', track: s.track || '',
				bodyMd: s.body_md || STYLE_TEMPLATE,
				busy: false, err: '', preview: false
			})
			const set = (k, v) => setF((p) => Object.assign({}, p, { [k]: v }))

			const save = async () => {
				if (!f.name.trim()) { set('err', '风格名必填'); return }
				if (!f.bodyMd.trim()) { set('err', '风格正文不能为空'); return }
				set('busy', true); set('err', '')
				try {
					const r = await apiPost('/api/workbench/styles', {
						code: s.code, name: f.name.trim(), kind: s.kind || 'personal',
						desc: f.desc.trim(), track: f.track.trim(),
						bodyMd: f.bodyMd,
						source: s.source || { type: 'manual' }
					})
					if (!r.ok) throw new Error(r.error || '保存失败')
					props.onSaved((isNew ? '已创建 ' : '已更新 ') + (r.code || s.code))
				} catch (e) {
					set('err', String((e && e.message) || e)); set('busy', false)
				}
			}

			const L = { fontSize: '11.5px', fontWeight: 650, marginBottom: '4px', color: 'var(--dsw-alias-label-secondary)' }
			const area = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', font: 'inherit', outline: 'none' }
			const mono = Object.assign({}, area, { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', lineHeight: '1.7' })

			const bodyPane = f.preview
				? h('pre', {
					style: Object.assign({}, mono, {
						minHeight: '360px', maxHeight: '46vh', overflowY: 'auto', whiteSpace: 'pre-wrap',
						margin: 0, background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)'
					})
				}, f.bodyMd)
				: h('textarea', {
					style: Object.assign({}, mono, { minHeight: '360px', maxHeight: '46vh', resize: 'vertical' }),
					value: f.bodyMd, onChange: (e) => set('bodyMd', e.target.value),
					spellCheck: false
				})

			return h('div', {
				style: {
					position: 'fixed', inset: 0, background: 'rgba(0,0,0,.38)', zIndex: 9999,
					display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '22px'
				},
				onClick: (ev) => { if (ev.target === ev.currentTarget) props.onClose() }
			},
				h('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '14px', width: '860px', maxWidth: '96%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 70px rgba(0,0,0,.42)' } },
					h('div', { style: { padding: '16px 18px 12px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' } },
						h('h2', { style: { margin: '0 0 10px', fontSize: '16px', fontWeight: 700 } }, isNew ? '创建新风格' : '编辑风格 ' + s.code),
						h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' } },
							h('input', { style: Object.assign({}, area, { flex: '1 1 240px' }), value: f.name, onChange: (e) => set('name', e.target.value), placeholder: '风格名 *，如：民生科普 · 哄睡体' }),
							h('input', { style: Object.assign({}, area, { width: '130px' }), value: f.track, onChange: (e) => set('track', e.target.value), placeholder: '适用赛道' })),
						h('input', { style: area, value: f.desc, onChange: (e) => set('desc', e.target.value), placeholder: '一句话说明（卡片副标题）' })),
					h('div', { style: { flex: '1 1 auto', overflowY: 'auto', padding: '12px 18px' } },
						h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
							h('div', { style: Object.assign({}, L, { margin: 0 }) }, '风格提示词（Markdown）'),
							h('span', { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' } },
								'这一整段就是最终写给模型的东西，可以直接复制走'),
							h('button', {
								type: 'button', style: Object.assign({}, S.mini, { marginLeft: 'auto' }),
								onClick: () => set('preview', !f.preview)
							}, f.preview ? '编辑' : '预览'),
							h('button', {
								type: 'button', style: S.mini,
								onClick: () => { set('bodyMd', STYLE_TEMPLATE); }
							}, '载入模板'),
							h('button', {
								type: 'button', style: S.mini,
								onClick: () => copyText(f.bodyMd, () => props.onSaved('已复制到剪贴板'))
							}, '复制')),
						bodyPane,
						h('div', { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)', marginTop: '6px' } },
							f.bodyMd.length + ' 字符 · ' + f.bodyMd.split('\n').length + ' 行'),
						f.err ? h('div', { style: S.err }, f.err) : null),
					h('div', { style: { padding: '12px 18px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
						h('button', { type: 'button', style: S.mini, onClick: props.onClose }, '取消'),
						h('button', {
							type: 'button', style: Object.assign({}, S.mini, { fontWeight: 650 }),
							disabled: f.busy, onClick: save
						}, f.busy ? '保存中…' : (isNew ? '创建' : '保存')))))
		}

		function DraftLibrary(props) {
			const drafts = props.drafts || []
			const sel = props.sel
			// 前端刚点的那个 draft（props.pendingId）：只有它能确定「正在跑」
			const runningId = props.runningId || null
			const waiting = drafts.filter((d) => d.status === 'queued')
			const D = {
				row: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', padding: '12px', marginTop: '10px' },
				k: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' },
				v: { fontSize: '12.5px', lineHeight: '1.75' },
				thumb: { width: '40px', height: '30px', borderRadius: '5px', border: '1px dashed var(--dsw-alias-border-l1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' },
				// 封面缩略图：封面是 2.35:1，按这个比例裁，不变形。
				// 必须放在**这个组件的** D 里——ViralLibrary 有自己的 D，
				// 放错地方会让 style=undefined，img 按浏览器默认尺寸撑满整行。
				thumbImg: {
					width: '112px', height: '48px', objectFit: 'cover',
					borderRadius: '5px', display: 'block',
					boxShadow: '0 1px 3px rgba(0,0,0,.14)',
					cursor: 'zoom-in',
					background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)'
				},
				thumbEmpty: {
					width: '112px', height: '48px', borderRadius: '5px',
					border: '1px dashed var(--dsw-alias-border-l1)',
					display: 'flex', alignItems: 'center', justifyContent: 'center',
					fontSize: '11px', color: 'var(--dsw-alias-label-secondary)'
				}
			}
			const stageChip = (st) => h('span', { style: S.tag }, DRAFT_LABEL[st] || st)

			// ── 创作进度 ────────────────────────────────────────────────
			// 为什么不用 status 当唯一依据：status 只在阶段切换那一刻变，
			// Agent 正在跑的时候它一动不动。真正的「进行中」信号有两个：
			//   ① props.runningId —— 前端刚点了推进，正在等 Agent
			//   ② started_at 距今 < STALE_MS —— 说明这一阶段刚被推进过，可能还在跑
			// 两者都拿不到时才退化成「静态显示当前阶段」。
			const STALE_MS = 10 * 60 * 1000      // 10 分钟内有 actions 视为可能还在跑
			const isRunning = (r, live) => {
				if (live) return true
				if (!r.started_at) return false
				const t = Date.parse(String(r.started_at).replace(' ', 'T'))
				return Number.isFinite(t) && Date.now() - t < STALE_MS
			}
			// 超过 30 分钟没动静，提示可能卡住（不报警，只给个视觉提示）
			//
			// 2026-11-08 修：原来没排除 queued，导致刚建的草稿全被标成「疑似卡住」。
			// queued = 还没开始写，它本来就不在跑，不存在「卡住」这个概念。
			// 同理 draftbox/published 是终态，也不该有卡住提示。
			const isStale = (r) => {
				if (r.status === 'queued') return false
				if (r.status === 'draftbox' || r.status === 'published') return false
				if (!r.started_at) return false
				const t = Date.parse(String(r.started_at).replace(' ', 'T'))
				return Number.isFinite(t) && Date.now() - t > 30 * 60 * 1000
			}
			const RUN_TEXT = {
				queued: '正在写初稿', draft: '正在打磨', polished: '正在审稿',
				reviewed: '正在排版', formatted: '正在生成配图',
				illustrated: '正在入草稿箱', draftbox: '已入草稿箱', published: '已群发'
			}

			const stageProgress = (r, live, stale) => {
				const cur = DRAFT_STAGES.indexOf(r.status)
				const running = isRunning(r, live)
				const done = r.status === 'draftbox' || r.status === 'published'
				return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
					// 步骤条
					h('div', {
						style: { display: 'flex', alignItems: 'center', gap: '3px' },
						title: DRAFT_STAGES.map((s, i) => (i <= cur ? '✓ ' : '· ') + DRAFT_LABEL[s]).join('\n')
					},
						DRAFT_STAGES.map((st, i) => {
							const passed = i < cur
							const current = i === cur
							return h('span', {
								key: st,
								style: {
									width: current ? '18px' : '12px',
									height: '6px',
									borderRadius: '3px',
									flex: '0 0 auto',
									background: passed ? 'var(--dsw-alias-label-primary)'
										: current ? (stale ? '#b54708' : 'var(--dsw-alias-label-primary)')
											: 'color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)',
									opacity: current && running && !stale ? 0.55 : 1,
									// 正在跑：用 CSS 动画呼吸。stale 时不呼吸，避免误以为还活着
									animation: current && running && !stale ? 'dswWbPulse 1.1s ease-in-out infinite' : 'none',
									transition: 'all .2s'
								}
							})
						})),
					// 文字：进行中 / 已结束 / 疑似卡住
					h('div', {
						style: {
							fontSize: '11px', lineHeight: '1.4',
							color: stale ? '#b54708' : (running && !done ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'),
							fontWeight: running && !done ? 600 : 400
						}
					},
						stale ? '疑似卡住 · ' + (DRAFT_LABEL[r.status] || r.status)
							: running && !done ? '进行中 · ' + (RUN_TEXT[r.status] || r.status)
								: (DRAFT_LABEL[r.status] || r.status) + ' · 第 ' + (cur + 1) + '/' + DRAFT_STAGES.length + ' 步'),
					// 时间戳（有就显示，方便判断新鲜度）
					r.started_at ? h('div', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } },
						String(r.started_at).slice(5, 16)) : null)
			}

			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto', position: 'relative' } },
				h('div', { style: S.head },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
						h('h1', { style: S.h1 }, '创作库'),
						h('button', {
							style: Object.assign({}, S.mini, { marginLeft: 'auto' }),
							type: 'button', disabled: !!props.busy,
							onClick: () => props.onNewConfig()
						}, '＋ 新建创作')),
					h('p', { style: S.sub }, props.loading
						? '正在读取 SQLite…'
						: '共 ' + drafts.length + ' 篇。'
							+ (waiting.length ? '待写 ' + waiting.length + ' 篇（在配置里点「开始创作」才会写）。' : '')
							+ ' 状态机：' + DRAFT_STAGES.map((x) => DRAFT_LABEL[x]).join(' → '))),
				h('div', { style: S.body },
					props.error ? h('div', { style: S.err }, '数据层不可用：' + props.error) : null,
					drafts.length === 0 && !props.loading
						? h('div', { style: S.placeholder },
							'还没有稿子。两条路：',
							h('div', { style: { marginTop: '6px' } },
								'· 点右上角【＋ 新建创作】，自己填主题和素材；'),
							h('div', null,
								'· 或到「选题库」点【选为写作】，把选题带进创作配置。'),
							h('div', { style: { marginTop: '6px' } },
								'两条路都会先停在「创作配置」，点【开始创作】才真正动笔。'))
						: h('div', { style: S.wrap },
							h('table', { style: S.table },
								h('thead', null, h('tr', null,
									h('th', { style: Object.assign({}, S.th, S.num) }, 'id'),
									h('th', { style: S.th }, '封面'),
									h('th', { style: S.th }, '标题'),
									h('th', { style: S.th }, '来源选题'),
									h('th', { style: S.th }, '赛道'),
									h('th', { style: S.th }, '写作技能'),
									h('th', { style: S.th }, '字数'),
									h('th', { style: Object.assign({}, S.th, { minWidth: '210px' }) }, '创作进度'),
									h('th', { style: S.th }, '操作'))),
								h('tbody', null, drafts.map((r) => h('tr', { key: 'd' + r.id },
									h('td', { style: Object.assign({}, S.td, S.num) }, r.id),
									// 封面：有图就显示缩略图，没图显示占位。
									// 路径走 /api/workbench/asset，相对路径基于草稿目录。
									h('td', { style: S.td }, r.cover
										? h('img', {
											src: '/api/workbench/asset?p=' + encodeURIComponent(
												((r.path || '').endsWith('/') ? r.path : (r.path || '') + '/') + r.cover),
											style: D.thumbImg,
											alt: '封面',
											title: (r.title || '') + '　（点击放大）',
											loading: 'lazy',
											onClick: () => {
												const zoom = props.onZoomCover
												if (typeof zoom === 'function') {
													zoom(
														'/api/workbench/asset?p=' + encodeURIComponent(
															((r.path || '').endsWith('/') ? r.path : (r.path || '') + '/') + r.cover),
														r.title || '',
														(r.words ? r.words + ' 字' : '') + (r.skill ? '　·　' + r.skill : '')
													)
												}
											}
										})
										: h('div', { style: D.thumbEmpty }, '无封面')),
									h('td', { style: S.td }, r.title || '（未命名）'),
									h('td', { style: Object.assign({}, S.td, { maxWidth: '200px' }) },
										r.source_title
											? h('span', {
												title: r.source_title,
												style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
											}, r.source_title)
											: h('span', { style: S.mono }, '—')),
									h('td', { style: S.td }, r.track || '—'),
									h('td', { style: S.td },
										h('div', null, r.skill || '—'),
										h('span', {
											style: Object.assign({}, S.tag, { fontSize: '10px', marginTop: '3px' }),
											title: r.skill_class === 'A' ? 'A 类：遵守 aws 配额，下游可自动跑' : 'B 类：保留文风，但过不了 aws 配额门禁'
										}, (r.skill_class || '?') + ' 类')),
									h('td', { style: Object.assign({}, S.td, S.mono) }, r.word_count || '—'),
									h('td', { style: S.td }, stageProgress(r, runningId === r.id, isStale(r))),
									h('td', { style: S.td },
										h('button', { style: S.mini, type: 'button', onClick: () => props.onPreview(r) }, '全文'),
										h('button', {
											style: Object.assign({}, S.mini, { marginLeft: '6px' }), type: 'button',
											onClick: () => props.onOpen(r)
										}, '详情'),
										DRAFT_ACTION[r.status]
											? h('button', {
												style: Object.assign({}, S.mini, { marginLeft: '6px' }), type: 'button',
												disabled: !!props.busy,
												// 待写（queued）先打开配置让人确认再动笔；其余阶段没有可配的东西，直接推进。
												onClick: () => (r.status === 'queued' ? props.onReconfig(r) : props.onAdvance(r))
											}, DRAFT_ACTION[r.status])
											: null,
										// 手工配图按钮：只在 formatted 阶段出现（图位已插、封面未生成）。
										// 2026-11-10 加：配图从自动流程里摘出来了，
										// 因为文章还可能改，改了就得重配，白烧生图额度。
										r.status === 'formatted'
											? h('button', {
												style: Object.assign({}, S.mini, {
													marginLeft: '6px',
													background: '#0b6bcb',
													color: '#fff',
													borderColor: '#0b6bcb',
													fontWeight: 650
												}),
												type: 'button',
												disabled: !!props.busy,
												title: '文章定稿后再点。会用掉 4-6 张图的生图额度',
												onClick: () => {
													if (!window.confirm(
														'配图会生成封面 + 4-6 张正文图，用掉一次生图额度。\n\n' +
														'文章已经定稿了吗？改稿后再配一次要重新生成全部图片。'
													)) return
													props.onComposeImages(r)
												}
											}, r.cover ? '重新配图' : '配图')
											: null,
										h('button', {
											style: Object.assign({}, S.mini, { marginLeft: '6px' }), type: 'button',
											onClick: () => props.onRemove(r)
										}, '移除')))))))
				),

				sel ? h('div', { style: S.drawer },
					h('button', { style: S.close, type: 'button', onClick: () => props.onOpen(null), title: '关闭' }, '✕'),
					h('div', { style: S.drawerHead },
						h('h2', { style: { margin: 0, fontSize: '16.5px', fontWeight: 650 } }, sel.title || '（未命名）'),
						h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
							stageChip(sel.status),
							h('span', { style: S.tag }, (sel.skill_class || '?') + ' 类'),
							h('span', { style: S.tag }, sel.track || '未设赛道'),
							h('span', { style: S.tag }, sel.skill || '未记技能'))),
					h('div', { style: S.drawerBody },
						sel.digest ? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '摘要'),
							h('div', { style: D.v }, sel.digest)) : null,
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '创作配置'),
							h('div', { style: D.k }, '主题'),
							h('div', { style: D.v }, sel.theme || sel.title || '（未设主题）'),
							h('div', { style: Object.assign({}, D.k, { marginTop: '8px' }) }, '用户要求（观点）'),
							h('div', { style: D.v }, sel.requirement || sel.viewpoint || '（未设要求）'),
							h('div', { style: Object.assign({}, D.k, { marginTop: '8px' }) },
								'参考素材 ' + (sel.materials ? '（' + sel.materials.length + ' 字）' : '')),
							h('div', { style: Object.assign({}, D.v, { whiteSpace: 'pre-wrap', maxHeight: '120px', overflow: 'auto' }) },
								sel.materials || '（未填素材）'),
							sel.status === 'queued'
								? h('button', {
									style: S.btn, type: 'button', disabled: !!props.busy,
									onClick: () => props.onReconfig(sel)
								}, '改配置并重新开始创作')
								: null),
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '作者观点（从选题带过来）'),
							h('div', { style: D.v }, sel.viewpoint || '（未设观点）')),
						h('div', { style: S.block },
							h('div', { style: D.blockTitle }, '进度'),
							h('div', { style: D.v },
								['字数 ' + (sel.word_count || '—'),
									'审稿问题 ' + (sel.review_issues || 0),
									'配图 ' + (sel.images_count || 0) + ' 张'].join(' · '))),
						h('div', { style: S.block },
							h('div', { style: D.blockTitle }, '资产'),
							h('div', { style: D.v }, '草稿目录：' + (sel.path || '—')),
							h('div', { style: D.v }, '封面：' + (sel.cover || '—'))),
						h('div', { style: S.block },
							h('div', { style: D.blockTitle }, '来源'),
							h('div', { style: D.v }, sel.source_title || '（无来源）'),
							h('div', { style: D.k }, '选题方案 #' + (sel.topic_id ?? '—')
								+ '｜' + (sel.source_platform || '') + ' ' + (sel.topic_source_key || ''))),
						h('div', { style: S.block },
							h('div', { style: D.blockTitle }, '时间'),
							h('div', { style: D.k }, '创建 ' + (sel.created_at || '—') + '｜更新 ' + (sel.updated_at || '—'))),
						DRAFT_ACTION[sel.status]
							? h('div', { style: S.block },
								h('div', { style: D.blockTitle }, '下一步'),
								h('button', {
									style: S.btn, type: 'button', disabled: !!props.busy,
									onClick: () => props.onAdvance(sel)
								}, DRAFT_ACTION[sel.status]),
								h('div', { style: Object.assign({}, S.doc, { marginTop: '8px', fontSize: '11.5px' }) },
									'会触发 Agent 按 skill 推进到下一阶段，并把产出回写到这里。'))
							: null)
				) : null
			)
		}

		// ── 发布管理：列表 + 详情抽屉 ──
		// 字段参照创作库：标题 / 来源选题 / 赛道 / 账号 / 方式 / 状态 / 时间。
		// 关键区分：方式 draft = 只进草稿箱（读者看不到）；published = 已群发。
		const PUB_METHOD = { draft: '进草稿箱', published: '群发' }
		const PUB_STATUS = {
			pending: '待上传', uploaded: '已上传草稿箱',
			published: '已群发', failed: '失败'
		}

		function PublishLibrary(props) {
			const pubs = props.publishes || []
			const sel = props.sel
			const M = {
				row: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', padding: '12px', marginTop: '10px' },
				k: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' },
				v: { fontSize: '12.5px', lineHeight: '1.75', wordBreak: 'break-all' },
				mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px' }
			}
			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto', position: 'relative' } },
				h('div', { style: S.head },
					h('h1', { style: S.h1 }, '发布管理'),
					h('p', { style: S.sub }, props.loading
						? '正在读取…'
						: '共 ' + pubs.length + ' 条记录。'
							+ '注意：方式『进草稿箱』只是提交到微信草稿箱，读者看不到；『群发』才是发出去。')),
				h('div', { style: S.body },
					props.error ? h('div', { style: S.err }, '数据层不可用：' + props.error) : null,
					pubs.length === 0 && !props.loading
						? h('div', { style: S.placeholder }, '还没有发布记录。到「创作库」把稿子推进到「已配图」，再点【入草稿箱】。')
						: h('div', { style: S.wrap },
							h('table', { style: S.table },
								h('thead', null, h('tr', null,
									h('th', { style: Object.assign({}, S.th, S.num) }, 'id'),
									h('th', { style: S.th }, '标题'),
									h('th', { style: S.th }, '来源选题'),
									h('th', { style: S.th }, '赛道'),
									h('th', { style: S.th }, '账号'),
									h('th', { style: S.th }, '方式'),
									h('th', { style: S.th }, '状态'),
									h('th', { style: S.th }, '时间'),
									h('th', { style: S.th }, '操作'))),
								h('tbody', null, pubs.map((r) => h('tr', { key: 'p' + r.id },
									h('td', { style: Object.assign({}, S.td, S.num) }, r.id),
									h('td', { style: S.td }, r.draft_title || ('草稿 #' + (r.draft_id ?? '—'))),
									h('td', { style: Object.assign({}, S.td, { maxWidth: '200px' }) },
										r.source_title
											? h('span', {
												title: r.source_title,
												style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
											}, r.source_title)
											: h('span', { style: S.mono }, '—')),
									h('td', { style: S.td }, r.track || '—'),
									h('td', { style: S.td }, r.account || '—'),
									h('td', { style: S.td }, h('span', { style: S.tag }, PUB_METHOD[r.method] || r.method || '—')),
									h('td', { style: S.td }, h('span', { style: S.tag }, PUB_STATUS[r.status] || r.status || '—')),
									h('td', { style: Object.assign({}, S.td, S.mono) }, (r.created_at || '').slice(5, 16)),
									h('td', { style: S.td },
										h('button', { style: S.mini, type: 'button', onClick: () => props.onOpen(r) }, '详情'),
										r.wechat_media_id
											? h('button', {
												style: Object.assign({}, S.mini, { marginLeft: '6px' }), type: 'button',
												onClick: () => copyText(r.wechat_media_id,
													() => props.onToast('已复制 media_id'))
											}, '复制ID')
											: null))))))
				),

				sel ? h('div', { style: S.drawer },
					h('button', { style: S.close, type: 'button', onClick: () => props.onOpen(null), title: '关闭' }, '✕'),
					h('div', { style: S.drawerHead },
						h('h2', { style: { margin: 0, fontSize: '16.5px', fontWeight: 650 } }, sel.draft_title || ('草稿 #' + sel.draft_id)),
						h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
							h('span', { style: S.tag }, PUB_METHOD[sel.method] || sel.method || '—'),
							h('span', { style: S.tag }, PUB_STATUS[sel.status] || sel.status || '—'),
							h('span', { style: S.tag }, sel.account || '未记账号'))),
					h('div', { style: S.drawerBody },
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '来源'),
							h('div', { style: M.v }, sel.source_title || '（无来源）'),
							h('div', { style: M.k }, [sel.source_platform || '', sel.track || ''].filter(Boolean).join(' · ')
								+ '｜选题 key ' + (sel.topic_source_key || '—'))),
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '微信 media_id'),
							h('div', { style: Object.assign({}, M.v, M.mono) }, sel.wechat_media_id || '（无）'),
							sel.wechat_media_id
								? h('button', {
									style: S.btn, type: 'button',
									onClick: () => copyText(sel.wechat_media_id, () => props.onToast('已复制 media_id'))
								}, '复制 media_id')
								: null,
							h('div', { style: Object.assign({}, M.k, { marginTop: '8px' }) },
								sel.method === 'draft'
									? '这是草稿箱凭证。要真正发出，需再执行 publish.py publish <media_id>。'
									: '这是已发布凭证。')),
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '备注'),
							h('div', { style: M.v }, sel.note || '（无）')),
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '时间'),
							h('div', { style: M.k }, '创建 ' + (sel.created_at || '—')
								+ '｜发布 ' + (sel.published_at || '—'))))
					) : null
			)
		}

		// ── 只读列表（创作库 / 发布管理） ──
		function ReadOnlyList(props) {
			return h('div', { style: S.body },
				h('div', { style: S.head }, h('h1', { style: S.h1 }, props.title),
					h('p', { style: S.sub }, props.loading ? '正在读取 SQLite…'
						: '共 ' + (props.rows || []).length + ' 条。')),
				props.error ? h('div', { style: S.err }, '数据层不可用：' + props.error) : null,
				(props.rows || []).length === 0
					? h('div', { style: S.placeholder }, props.emptyHint || '（空）')
					: h('div', { style: S.wrap },
						h('table', { style: S.table },
							h('thead', null, h('tr', null, props.cols.map((c) => h('th', { key: c.key, style: S.th }, c.label)))),
							h('tbody', null, props.rows.map((r) => h('tr', { key: r.id },
								props.cols.map((c) => h('td', { key: c.key, style: S.td }, String(r[c.key] ?? '—')))))))
					)
			)
		}

		// ── 工作台视图 ──
		// ══════════════════════════════════════════════════════════════
		// 生图工作台
		//
		// 画廊（handraw-style 的 gallery/index.html）是只读的静态浏览页：
		// 筛选、看大图、复制提示词。这里把同一批数据搬进面板，并补上画廊没有的三件事：
		//   ① 选中的风格/图型/色卡能带到生成页，不用手工复制粘贴编号
		//   ② 编号参考图自动垫进生图接口（预研结论：这是「画法经济性」类风格的必要条件）
		//   ③ 生成物落库，可回看、可重跑
		//
		// 数据来源与画廊同一份：references/styles.json / layouts.json / colors.json。
		// 路径换算只在 image-gen.py 里做，前端不做二次解析。
		// ══════════════════════════════════════════════════════════════
		const IS = {
			// 视图容器的固定写法：**必须** minHeight:0 + flex:1 1 auto。
			// S.page 是 height:100% 的列向 flex，中间这层不给约束就会被内容撑开、
			// 内层 S.body 的 overflow:auto 拿不到有界高度 —— 表现就是整页滚不动。
			flexCol: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto', position: 'relative' },
			subTabs: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' },
			grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(164px, 1fr))', gap: '11px', marginTop: '12px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)', borderRadius: '14px', padding: '14px' },
			card: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', padding: '8px', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '6px' },
			cardOn: { borderColor: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))', boxShadow: '0 0 0 1px var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)) inset' },
			thumb: { width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: '7px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)', display: 'block' },
			name: { fontSize: '12.5px', fontWeight: 600, lineHeight: '1.35', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
			meta: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.45', wordBreak: 'break-word' },
			idBadge: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' },
			row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
			field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '132px' },
			label: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
			select: { padding: '6px 9px', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit' },
			primary: { padding: '7px 16px', borderRadius: '8px', border: '1px solid var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))', background: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))', color: 'var(--dsw-alias-bg-layer-1)', font: 'inherit', fontWeight: 650, cursor: 'pointer' },
			primaryOff: { opacity: .45, cursor: 'default' },
			pill: { fontSize: '11px', padding: '2px 9px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
			pillOn: { borderColor: 'var(--dsw-alias-label-primary)', fontWeight: 650 },
			stat: { flex: '1 1 0', minWidth: 0, border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '9px', padding: '9px 12px' },
			statN: { fontSize: '17px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
			statL: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
			jrow: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '8px 0', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', fontSize: '12px' },
			code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', padding: '2px 8px', borderRadius: '6px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', whiteSpace: 'nowrap' },
			// ── 生成工作室：左表单 + 右预览（对齐参考产品的交互范式）──
			overlay: { position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '22px' },
			overlayCard: { background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '12px', maxWidth: '1000px', width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: '18px', boxShadow: '0 24px 70px rgba(0,0,0,0.42)' },
			badgeOn: { position: 'absolute', top: '6px', left: '6px', background: 'rgba(0,0,0,0.68)', color: '#fff', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', fontWeight: 600 },
			studio: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
			// 左右配比：表单列给足宽度（里面有三列选择卡、情绪 chip、分镜步进器，
			// 470px 会把它们挤成两行），但**让它在窄窗口能缩**：clamp 而不是写死，
			// 否则窗口一小表单列就吃掉预览。
			formCol: { flex: '0 0 clamp(470px, 40%, 700px)', minHeight: 0, overflowY: 'auto', borderRight: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', padding: '14px 16px 20px', display: 'flex', flexDirection: 'column', gap: '11px' },
			previewCol: { flex: '1 1 0', minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '14px 18px 22px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent)' },
			sec: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '12px', padding: '11px 13px', background: 'var(--dsw-alias-bg-layer-1)' },
			secHead: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '9px', flexWrap: 'wrap' },
			secNo: { width: '20px', height: '20px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, background: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))', color: 'var(--dsw-alias-bg-layer-1)', flex: '0 0 auto' },
			seg: { display: 'inline-flex', gap: '3px', padding: '3px', borderRadius: '9px', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)' },
			segBtn: { border: 0, borderRadius: '7px', padding: '5px 11px', font: 'inherit', fontSize: '12.5px', cursor: 'pointer', background: 'transparent', color: 'inherit' },
			segOn: { background: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))', color: 'var(--dsw-alias-bg-layer-1)', fontWeight: 650 },
			chip: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '999px', padding: '4px 11px', font: 'inherit', fontSize: '12px', cursor: 'pointer', background: 'transparent', color: 'inherit' },
			chipOn: { borderColor: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)) 12%, transparent)', fontWeight: 650 },
			rowWrap: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
			// 选择卡：**竖长型**（缩略图 3:4）+ 等宽网格填满一行。
			// 之前是 flex 1 1 132px 配 62px 高的扁缩略图：三张一挤就换行，卡片比例也不统一。
			pickCard: { border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '8px', cursor: 'pointer', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 },
			pickThumb: { width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: '7px', display: 'block', background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)' },
			pickGrid: { display: 'grid', gap: '8px', alignItems: 'start' },
			stickBar: { position: 'sticky', bottom: 0, paddingTop: '12px', display: 'flex', gap: '8px', alignItems: 'center', background: 'linear-gradient(transparent, var(--dsw-alias-bg-layer-1) 36%)' },
			previewBox: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1)', padding: '12px', marginBottom: '12px' },
			status: { fontSize: '10.5px', padding: '1px 8px', borderRadius: '999px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', whiteSpace: 'nowrap' }
		}
		const IS_STATUS_COLOR = {
			queued: 'var(--dsw-alias-label-secondary)',
			running: '#b76e00',
			done: '#1a7f37',
			failed: '#b42318'
		}
		const IS_STATUS_ZH = { queued: '排队', running: '生成中', done: '已完成', failed: '失败' }
		const ASSET_LABEL = { characters: '角色库', props: '道具库', scenes: '场景库' }

		function ImageStudio(props) {
			const MODULES = (props && props.modules) ||
				['漫图创作', '风格库', '图型库', '主色调', '角色资产库', '我的创作', '技能包']
			const [mod, setMod] = React.useState(MODULES[0])
			const [catalog, setCatalog] = React.useState(null)
			const [catError, setCatError] = React.useState('')
			const [group, setGroup] = React.useState('')
			const [q, setQ] = React.useState('')
			const [drawer, setDrawer] = React.useState(null)
			const [layoutDoc, setLayoutDoc] = React.useState(null)
			// 资产库（角色/道具/场景）：数据来自技能自带的 custom_library_manager，不落 SQLite
			const [assetLib, setAssetLib] = React.useState(null)
			const [assetCat, setAssetCat] = React.useState('characters')
			const [assetRefs, setAssetRefs] = React.useState([])      // 垫图（可多选：画风之外的角色/道具/场景）
			const [createMode, setCreateMode] = React.useState('one-shot')  // one-shot 一键生图 | stepwise 分步精修 | comic 漫画流
			// 漫画流：一段文案 → N 个分镜，各出一张图
			const [sourceText, setSourceText] = React.useState('')
			const [panelCount, setPanelCount] = React.useState(0)      // 0 = 自动（按段落数）
			const [seriesPreview, setSeriesPreview] = React.useState(null)  // 拆解预览（不落库）
			const [series, setSeries] = React.useState(null)           // 最近一次漫画流（含分镜与产出）
			const [seriesList, setSeriesList] = React.useState([])     // 全部漫画流（资产库按系列归组用）
			const [panelView, setPanelView] = React.useState(null)     // 分镜查看器：一个系列的全部图
			const [assetFilter, setAssetFilter] = React.useState('')   // 资产库筛选：'' | series | single | 出图模式
			const [previewJobId, setPreviewJobId] = React.useState(null)  // 渲染预览显示哪一次任务
			// 拍摄类型：领域来自技能包里的 couple-photo-orchestrator
			// （情侣 / 婚纱 / 家庭 / Cosplay 等专业人像摄影编排技能）。
			// ⚠️ 它本身是一套带确认关卡和状态文件的**多阶段编排流程**，不是一句提示词模板，
			// 所以这里只是把「拍摄类型」作为场景层约束写进提示词，**不等于实现了那个技能**。
			const PHOTO_TYPES = ['情侣', '婚纱', '个人写真', '亲子全家福', '古风汉服', '新中式',
				'复古港风', 'Cosplay', '旅行抓拍', '职场肖像']
			// 画面文字语言。**技能没有这个参数** —— prompt_style.py 的 `--language {auto,zh,en}`
			// 管的是「提示词自己用哪种语言写」（输出 zh 还是 en 的提示词），
			// 不是「画面里渲染出来的文字用哪种语言」。后者技能里没有任何规范，
			// 所以这是工作台叠的约束，走附加约束通道，界面上如实标注。
			//
			// 为什么必须有：一组详情图 6 张，模型会随机制中英文 ——
			// 出来就是中英混排，整组没法用（实测）。
			const TEXT_LANGS = [
				{ v: 'auto', label: '跟随文案', extra: '画面中出现的所有文字，一律使用与主题/商品信息相同的语言（主题是中文就用简体中文），不要中英混排' },
				{ v: 'zh', label: '简体中文', extra: '画面中出现的所有文字一律使用简体中文，不要出现英文单词或其他语言文字' },
				{ v: 'tw', label: '繁體中文', extra: '畫面中出現的所有文字一律使用繁體中文，不要出現簡體字、英文或其他語言文字' },
				{ v: 'en', label: 'English', extra: 'All text appearing in the image must be in English only; do not mix in any other language' },
				{ v: 'ms', label: '马来西亚语', extra: 'Semua teks dalam imej mesti dalam Bahasa Melayu sahaja. Jangan gunakan bahasa Inggeris, bahasa Cina atau bahasa lain.' },
				{ v: 'id', label: '印尼语', extra: 'Semua teks dalam gambar harus dalam Bahasa Indonesia saja. Jangan gunakan bahasa Inggris, bahasa Mandarin, atau bahasa lain.' },
				{ v: 'th', label: '泰语', extra: 'ข้อความทั้งหมดในภาพต้องเป็นภาษาไทยเท่านั้น ห้ามใช้ภาษาอังกฤษ ภาษาจีน หรือภาษาอื่น' },
				{ v: 'vi', label: '越南语', extra: 'Tất cả văn bản trong hình phải bằng tiếng Việt. Không dùng tiếng Anh, tiếng Trung hay ngôn ngữ khác.' },
				{ v: 'tl', label: '菲律宾语', extra: 'Ang lahat ng teksto sa larawan ay dapat nasa Tagalog lamang. Huwag gumamit ng Ingles, Tsino, o ibang wika.' },
				{ v: '', label: '不指定', extra: '' }
			]
			// 电商详情页的拆解配方。**每一项都是技能自带的 EC 图型编号与名称，不是我编的场景名** ——
			// 技能里那 24 个电商图型本身就是一套完整的详情页镜头表（主图 / 多角度 / 细节 / 包装 /
			// 卖点 / 功能演示 / 参数尺寸 / 材质解析 / 生活方式场景 / 人物使用 / 对比优势 / SKU差异 …）。
			// 按常规详情页图序取前 N 个即可。
			// 第 4 位 = 这张画面**要不要出现人物**。挂了人物参考图之后，这一位是必需的：
			// 模型拿到「1 张人物 + N 张商品图」时不会自己想"哪张该有人"，必须逐张告诉它。
			// 主图/细节/参数/包装是产品位，不该有人；场景/使用/上市这类才需要人。
			const EC_RECIPE = [
				['EC-001', '单品主图', '纯白/纯净背景，第一眼看清商品', 0],
				['EC-009', '生活方式场景图', '商品放在真实生活场景里', 1],
				['EC-005', '卖点标注图', '标注核心卖点', 0],
				['EC-003', '细节特写图', '材质与工艺特写', 0],
				['EC-007', '参数尺寸图', '尺寸与规格对比', 0],
				['EC-004', '包装/内容物图', '包装、套装与内容物', 0],
				['EC-010', '人物使用图', '同一个人正在使用该商品', 1],
				['EC-002', '多角度展示图', '多角度展示同一商品', 0],
				['EC-008', '材质/结构解析图', '拆解材质与结构', 0],
				['EC-013', '对比优势图', '与替代方案的差异', 0],
				['EC-017', '品质/工艺说明图', '品质与工艺', 0],
				['EC-021', '新品上市图', '新品上市主视觉，可含人物', 1]
			]
			const ecShots = (n) => EC_RECIPE.slice(0, Math.max(1, Math.min(n, EC_RECIPE.length)))
				.map(([layoutId, label, intent, person]) => ({ layoutId, label, intent, person: !!person }))
			// 商品信息的写法指引。**关键不是"格式"，而是"哪几张图会读哪一部分"** ——
			// 知道 EC-007 参数尺寸图要吃规格、EC-005 卖点图要吃卖点，才知道该写什么。
			const EC_INFO_FIELDS = [
				['品名 / 品类', '轻量保温杯', '全部（图片主体是什么，必须最先说清）'],
				['材质 / 成分', '316 不锈钢内胆，杯身磨砂，杯盖食品级 PP', '细节特写图 EC-003、材质解析 EC-008'],
				['规格 / 尺寸 / 重量', '500ml，高 21cm，直径 6.8cm，净重 280g', '参数尺寸图 EC-007、多角度 EC-002'],
				['核心卖点（3–5 条）', '24 小时保温 / 单手开盖 / 360° 防漏 / 杯底防滑', '卖点标注图 EC-005、对比优势 EC-013'],
				['使用场景', '通勤、办公室、健身房、户外徒步', '生活场景图 EC-009、多场景适用 EC-011'],
				['目标人群', '25–35 岁上班族、健身人群', '人物使用图 EC-010、内容种草 EC-023'],
				['款式 / 颜色', '雾蓝 / 燕麦白 / 墨绿 / 曜石黑', 'SKU 差异图 EC-014、主图 EC-001']
			]
			const EC_INFO_EXAMPLE = [
				'品名：轻量保温杯',
				'材质：316 不锈钢内胆，杯身磨砂喷砂，杯盖食品级 PP',
				'规格：500ml，高 21cm，直径 6.8cm，净重 280g',
				'卖点：24 小时保温 / 单手开盖 / 360° 防漏 / 杯底防滑硅胶',
				'场景：通勤、办公室、健身房、户外徒步',
				'人群：25–35 岁上班族、健身人群',
				'款式：雾蓝 / 燕麦白 / 墨绿 / 曜石黑'
			].join('\n')
			// 文字排布：**技能没有这个参数** —— 技能里的文字排布是靠「图型」表达的
			// （SC-004 上下双格图文分区卡、SC-005 气泡文字思考IP卡…），SKILL.md 只有一个固定的图文后缀。
			// 所以这里走「附加约束」通道，界面上也如实标注，不假装技能原生支持。
			const TEXT_LAYOUTS = [
				{ v: '', label: '技能默认', extra: '' },
				{ v: 'image-top-text-bottom', label: '图上字下',
				  extra: '画面占据上部，文字置于画面下方，文字与画面之间留出呼吸间距' },
				{ v: 'text-image-text', label: '字上图下',
				  extra: '文字分置画面上下：上方为标题、下方为文案，画面夹在中间' },
				{ v: 'caption', label: '旁白/标题',
				  extra: '文字作为旁白或标题直接融入画面构图，不画对话气泡' },
				{ v: 'bubble', label: '气泡对话',
				  extra: '台词画成对话气泡，气泡嵌入画面内部，气泡尾巴指向说话者' },
				{ v: 'no-text', label: '画面不出现文字',
				  extra: '画面中不要出现任何文字或字母' }
			]
			// 出图模式 = 六种场景，**每种带出自己的画幅比例**（模式与比例是对应的）。
			// 技能的「真模式」只有 pure-image / graphic-text 两种，所以只在这六种里映射；
			// 多出来的四个是工作台叠的场景层：画幅 + 留白 + 一条构图要求。
			const [outMode, setOutMode] = React.useState('pure-image')
			const [textLayout, setTextLayout] = React.useState('')    // 文字排布（走附加约束）
			const [textLang, setTextLang] = React.useState('auto')    // 画面文字语言（走附加约束）
			const [photoType, setPhotoType] = React.useState('')      // 拍摄类型（摄影模式，走附加约束）
			const [photoInput, setPhotoInput] = React.useState('')
			// 「本次上传」的商品图/临时参考图：**不进资产库**，只服务于当前这次生成
			const [uploads, setUploads] = React.useState([])
			const [uploadBusy, setUploadBusy] = React.useState(false)
			// 电商详情页多图：一次出「主图 / 场景 / 卖点 / 细节 / 参数…」一整组
			const [ecMulti, setEcMulti] = React.useState(false)
			const [ecCount, setEcCount] = React.useState(6)
			const [ecGuide, setEcGuide] = React.useState(false)      // 展开「商品信息怎么写」
			const [ratio, setRatio] = React.useState('')
			const [whitespace, setWhitespace] = React.useState('')
			const [moods, setMoods] = React.useState([])
			const [moodInput, setMoodInput] = React.useState('')      // 自定义情绪输入
			const [mountPath, setMountPath] = React.useState('')      // 图库目录挂载路径
			const [mountBusy, setMountBusy] = React.useState(false)
			const [libGen, setLibGen] = React.useState(null)          // 自建资产的独立生成抽屉
			const [decision, setDecision] = React.useState(null)      // 能力判定结果（预览后拿到，界面要展示原因）
			// 风格融合：角色视觉语言 × 场景视觉语言（技能包里是独立技能，独立拼装路径）
			const [fusionOn, setFusionOn] = React.useState(false)
			const [sceneStyle, setSceneStyle] = React.useState('')    // 编号（FA-018）或名称（写实）
			const [sceneName, setSceneName] = React.useState('')      // 场景风格的自定义名称输入
			const [lightbox, setLightbox] = React.useState(null)      // 放大预览：{src, title, sub}
			const [promptModal, setPromptModal] = React.useState(null)  // 提示词预览弹窗
			const [picker, setPicker] = React.useState(null)          // 打开的挑选抽屉：style|layout|color|assets
			const [pickQ, setPickQ] = React.useState('')              // 挑选器内的搜索
			const [pickGroup, setPickGroup] = React.useState('')      // 挑选器内的分类
			const [saveTarget, setSaveTarget] = React.useState(null)  // 待归档的生成物
			const [saveName, setSaveName] = React.useState('')
			const [saveCat, setSaveCat] = React.useState('characters')
			const [assetBusy, setAssetBusy] = React.useState(false)
			const [assetErr, setAssetErr] = React.useState('')
			const [sel, setSel] = React.useState({ style: null, color: null, layout: null })
			// ① **选择跨刷新保留**。`sel` 是内存状态，刷新就回到"未选" ——
			//    而用户以为选过了。这正是「我明明选了风格，却报 styleId required」的来源：
			//    选完风格后页面刷新过（改代码/切页面），选择静默丢失。
			//    只存 id，真正的对象等 catalog 加载回来后按 id 回填 ——
			//    存对象会在技能库更新后指向一个已经不存在的条目。
			const SEL_STORE_KEY = 'dsh-workbench:image-sel'
			const selWant = React.useRef((function () {
				try { return JSON.parse(window.localStorage.getItem(SEL_STORE_KEY) || '{}') || {} }
				catch (err) { return {} }
			})())
			React.useEffect(() => {
				const w = selWant.current
				if (!catalog || !w || (!w.style && !w.layout && !w.color)) return
				selWant.current = null            // 只回填一次，之后以用户操作为准
				setSel({
					style: (catalog.styles || []).find((x) => x.id === w.style) || null,
					layout: (catalog.layouts || []).find((x) => x.id === w.layout) || null,
					color: (catalog.colors || []).find((x) => x.id === w.color) || null
				})
			}, [catalog])
			React.useEffect(() => {
				try {
					window.localStorage.setItem(SEL_STORE_KEY, JSON.stringify({
						style: (sel.style && sel.style.id) || '',
						layout: (sel.layout && sel.layout.id) || '',
						color: (sel.color && sel.color.id) || ''
					}))
				} catch (err) { /* 存不了就算了，不影响本次使用 */ }
			}, [sel])
			// ② **"是否选了风格"只能有一个判定**。
			//    原来守卫用 `!sel.style`（对象真值）、后端用 `body.styleId`（id 字符串）。
			//    两者一旦不一致，用户就会看到后端那句冷冰冰的 styleId required，
			//    而不是客户端自己的引导 —— 一个条件两处写法，必然漂移。
			const styleReady = !!(sel.style && sel.style.id)
			const [theme, setTheme] = React.useState('')
			const [withRef, setWithRef] = React.useState(true)
			const [arms, setArms] = React.useState('ref')
			const [size, setSize] = React.useState('')
			const [jobs, setJobs] = React.useState([])
			const [assets, setAssets] = React.useState([])
			const [usage, setUsage] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [err, setErr] = React.useState('')
			const [toast, setToast] = React.useState('')

			// ⚠️ 这个 hook 的位置有两个约束，缺一不可：
			//   1. 必须在 **jobs / assets 声明之后** —— 它要从 jobs 算依赖（否则 TDZ 报错）；
			//   2. 必须在**组件中段的两个早期 return（catError / !catalog）之前** ——
			//      否则「首屏 catalog 未加载 → 提前返回」与「加载完成 → 全部执行」之间
			//      hook 数量会变，React 抛 #310 并卸载整棵子树 → 白屏。
			// 两条都踩过一次。再见到白屏，先确认它还在这个区间里。
			const [previewTick, setPreviewTick] = React.useState(0)
			// 主题润色：**结果先落地为待确认状态**，不直接写回 theme
			// （hook 位置同 previewTick 的两个约束：在 jobs 之后、早期 return 之前）
			const [polishBusy, setPolishBusy] = React.useState(false)
			const [polishResult, setPolishResult] = React.useState(null)
			// 智能分镜：分析中标记 + 已拆出的分镜。
			// **拆出的结果要留着给提交用** —— 只预览不落地的话，用户点「开始创作」
			// 时服务端会重跑一次，两次结果不一样（模型非确定性），预览等于白看。
			const [splitBusy, setSplitBusy] = React.useState(false)
			// 角色资产的「人物描述」弹层。数据来自工作台的旁挂文件
			// （workbench/asset-notes.json，由 assets 接口带下来）。
			const [assetDetail, setAssetDetail] = React.useState(null)
			const [smartPanels, setSmartPanels] = React.useState([])
			// 与 smartPanels 同长度同顺序。**分开存**而不是拼进画面描述 ——
			// 对白要不要画进格子是用户的选择，拼进去就再也拆不开了。
			const [smartDialogues, setSmartDialogues] = React.useState([])
			// 后期备注（滤镜、语速、配乐、重复几遍）。**不进出图提示词** ——
			// 它们不是画面内容，写进去只会让模型在图上画个滤镜图标之类的东西。
			const [smartNotes, setSmartNotes] = React.useState([])
			// 全片固定的人物外形（智能分镜提炼）。它会被并进系列的 constraint，
			// 每格共享 —— 不加角色资产时，这是防止「同一个人每格长得不一样」的兜底。
			const [smartCast, setSmartCast] = React.useState([])
			const [withDialogue, setWithDialogue] = React.useState(true)
			const previewBusy = !!(previewJobId && jobs.some((j) => j.id === previewJobId
				&& (j.status === 'queued' || j.status === 'running')))
			React.useEffect(() => {
				if (!previewBusy) return undefined
				const t = window.setInterval(() => setPreviewTick((x) => x + 1), 1000)
				return () => window.clearInterval(t)
			}, [previewBusy])

			const flash = (m) => { setToast(m); window.setTimeout(() => setToast(''), 2600) }
			// 主题润色：拿到建议后**只放进 polishResult**，等用户点「用这个」才写回 theme。
			// 这是这个功能的核心约束 —— 自动替换会让用户以为"模型理解错了",
			// 而其实是他的输入在中途被换掉了。
			const doPolishTheme = async () => {
				if (!theme.trim()) { flash('先写点什么再润色'); return }
				setPolishBusy(true)
				try {
					const r = await apiPost('/api/workbench/image-jobs',
						{ action: 'polish-theme', theme: theme.trim() })
					if (!r.ok) throw new Error(r.error || '润色失败')
					if (!r.changed) { flash('模型认为这句不用改'); return }
					setPolishResult(r)
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally { setPolishBusy(false) }
			}
			// 切模块时清掉筛选与搜索：四个画廊各自独立，条件串味会让人以为点错了库
			const goTab = (m) => { setMod(m); setQ(''); setGroup('') }

			React.useEffect(() => {
				let dead = false
				apiGet('/api/workbench/image-catalog').then((d) => {
					if (dead) return
					setCatalog(d)
					setCatError('')
				}).catch((e) => { if (!dead) setCatError(String((e && e.message) || e)) })
				return () => { dead = true }
			}, [])

			const reload = React.useCallback(async () => {
				try {
					const d = await apiGet('/api/workbench/image-jobs')
					setJobs(d.jobs || [])
					setAssets(d.assets || [])
					setUsage(d.usage || null)
					setErr('')
				} catch (e) {
					setErr(String((e && e.message) || e))
				}
			}, [])

			React.useEffect(() => { reload() }, [reload])

			// 选中风格就自动查能力判定 —— 这是「要不要垫图」的依据，不该藏在一个按钮后面
			React.useEffect(() => {
				if (!styleReady) { setDecision(null); return }
				let dead = false
				apiGet('/api/workbench/image-catalog?decision=' + encodeURIComponent(sel.style.id))
					.then((d) => { if (!dead && d && d.ok) setDecision(d) })
					.catch(() => { /* 判定拿不到不影响主流程 */ })
				return () => { dead = true }
			}, [sel.style])

			// ── 资产库（角色 / 道具 / 场景）──
			//   数据源是技能自带的 custom_library_manager（外部图库目录 + library.json），
			//   所以不缓存、不走 SQLite；init / save 都是转发给它。
			const reloadAssets = React.useCallback(async () => {
				try {
					const d = await apiGet('/api/workbench/image-assets')
					setAssetLib(d && d.ok ? d : null)
					setAssetErr(d && d.ok ? '' : ((d && d.error) || '读不到资产库'))
				} catch (e) {
					setAssetErr(String((e && e.message) || e))
				}
			}, [])

			React.useEffect(() => { reloadAssets() }, [reloadAssets])

			// 自建资产抽屉在等出图时，把结果接回来（不轮询接口，跟着全局 jobs/assets 走）
			React.useEffect(() => {
				setLibGen((cur) => {
					if (!cur || !cur.jobId) return cur
					const j = jobs.find((x) => x.id === cur.jobId)
					if (!j) return cur
					if (j.status === 'failed' && !cur.error) {
						return Object.assign({}, cur, { error: String(j.error || '生成失败') })
					}
					const a = assets.find((x) => x.job_id === j.id)
					// 同步**真实任务状态**：排队中 / 生成中 / 已完成。
					// 只写一句"生成中"会把「进程压根没起来」也盖住 —— 状态词就是诊断信息。
					if (a && cur.relPath !== a.rel_path) {
						return Object.assign({}, cur, { relPath: a.rel_path, jobStatus: j.status })
					}
					if (cur.jobStatus !== j.status) {
						return Object.assign({}, cur, { jobStatus: j.status })
					}
					return cur
				})
			}, [jobs, assets])

			// ── 漫画流 ──
			const reloadSeries = React.useCallback(async () => {
				try {
					const d = await apiGet('/api/workbench/image-series')
					const list = (d && d.seriesList) || []
					setSeriesList(list)
					setSeries(list[0] || null)
				} catch (e) { /* 拿不到系列不影响主流程 */ }
			}, [])
			React.useEffect(() => { reloadSeries() }, [reloadSeries])

			const doSplitPreview = async (smart) => {
				if (!sourceText.trim()) { flash('先贴文案'); return }
				if (smart) setSplitBusy(true)
				try {
					const d = await apiPost('/api/workbench/image-series',
						{ action: 'preview', sourceText, count: panelCount, smart: !!smart })
					if (!d.ok) throw new Error(d.error || '拆解失败')
					setSeriesPreview(d)
					// 智能分镜的结果**留下来**；确定性预览则清掉旧的，避免
					// 「看了确定性的、提交的却是上一次 AI 的」这种错配。
					setSmartPanels(smart ? (d.panels || []) : [])
					setSmartDialogues(smart ? (d.dialogues || []) : [])
					setSmartNotes(smart ? (d.notes || []) : [])
					setSmartCast(smart ? (d.cast || []) : [])
					const m = d.meta || {}
					if (smart) flash('AI 拆出 ' + m.produced + ' 镜，点「开始创作」就用这一版')
					else if (m.short) flash('这段文字只能拆出 ' + m.produced + ' 镜（想更多用「AI 智能分镜」）')
					else flash('可拆 ' + m.produced + ' 镜')
				} catch (e) { flash(String((e && e.message) || e)) }
				finally { if (smart) setSplitBusy(false) }
			}

			// 角色垫图覆盖了哪些人物名。双向包含：资产叫「小勇」或「小勇正面」
			// 都能盖住 cast 里的「小勇」。短名（1 字）不参与反向包含，
			// 否则资产名「小」会把所有人都盖掉。
			// 注意保护要加在**资产名**上而不是角色名上：危险的是短资产名。
			const assetNamesCover = (name) => {
				const n = String(name || '').trim()
				if (!n) return false
				return assetRefs.some((r) => {
					const a = String(r.name || '').trim()
					if (!a) return false
					return a.includes(n) || (a.length >= 2 && n.includes(a))
				})
			}
			// 被角色垫图接管、因而不再注入文字描述的人物名（界面据此说明）
			const castCovered = smartCast.filter((c) => assetNamesCover(c.name))
			const castInjected = smartCast.filter((c) => !assetNamesCover(c.name))

			const doComic = async () => {
				if (!styleReady) { flash('先选一个风格'); goTab('风格库'); return }
				if (!sourceText.trim()) { flash('先贴漫画文案'); return }
				setBusy(true)
				try {
					// 有 AI 拆好的分镜就**显式传过去**，而不是让服务端再拆一次：
					// 再拆一次会得到不同的一版，预览与实出对不上。
					const body = smartPanels.length
						? Object.assign({ action: 'create', count: smartPanels.length,
							// 原文一并带上：分镜虽已拆好，但原文是这一组图的出处，
							// 系列记录要留；电商多图那条路也是这么发的（sourceText + panels）。
							sourceText,
							// 人物形象随系列下发，全片共用一份。
							// **已经用角色垫图锚定的人物要剔除** —— 图像优先。
							// 两者不一致时同时下发，模型收到的是互相矛盾的要求，
							// 只会随机偏向一边，比只用其中一个更糟。
							cast: smartCast.filter((c) => !assetNamesCover(c.name)),
							panels: smartPanels.map((t, i) => ({
								text: t,
								// 对白在这里按开关决定要不要并入画面描述。
								// 分开存在 state、合并在这一处 —— 只有这一个地方做决定。
								dialogue: (withDialogue && smartDialogues[i]) ? smartDialogues[i] : ''
							})) }, genPayload())
						: Object.assign({ action: 'create', sourceText, count: panelCount }, genPayload())
					const created = await apiPost('/api/workbench/image-series', body)
					if (!created.ok) throw new Error(created.error || '创建漫画流失败')
					const run = await apiPost('/api/workbench/image-series',
						{ action: 'run', seriesId: created.seriesId })
					if (!run.ok) throw new Error(run.error || '启动失败')
					flash('已开始生成 ' + created.panelCount + ' 镜（一组 ' + created.panelCount + ' 张，按张计费）')
					await reloadSeries()
					await reload()
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally { setBusy(false) }
			}

			const libReady = !!(assetLib && assetLib.library && assetLib.library.initialized)
			const libDefaultDir = (assetLib && assetLib.library && assetLib.library.defaultDir) || ''

			/**
			 * 自建资产的**独立生成**（角色 / 道具 / 场景基准图）。
			 *
			 * 刻意**不跳去漫图创作**：这里要做的只是"出一张基准图"这一件事，
			 * 跳去另一个模块会把一条短链路拉长成两段（切页 → 填 6 个分组 → 回来 → 再存）。
			 * 所以原地开一个小抽屉走完闭环：填 → 生成 → 结果 → 存入本库。
			 *
			 * 字段按"够用就好"给：提示词、参考图（可选）、比例、风格（可选，不选则沿用
			 * 漫图创作里当前选中的那个 —— 提示词必须有风格，这是技能的硬要求）。
			 */
			const openLibGen = (catKey) => {
				const cat = (assetLib && assetLib.categories && assetLib.categories[catKey]) || {}
				setLibGen({
					catKey, name: '', prompt: '', ratio: '1:1',
					styleId: '',            // 留空 = 不依赖风格库
					upRel: '', upName: '', busy: false, uploadBusy: false,
					jobId: null, relPath: '', error: '', saved: '', saveErr: '',
					autoSave: true, startedAt: 0
				})
			}
			const libGenPatch = (patch) => setLibGen((cur) => Object.assign({}, cur, patch))
			// 比例：只写比例本身，不带「封面 / 贴图」这类业务名（那是场景，不是比例）。
			// 「智能」= 不指定画幅，交给接口用配置默认尺寸，提示词里也不写画幅行。
			const LIB_RATIOS = ['', '1:1', '3:4', '16:9', '4:3', '9:16', '2:3', '3:2', '21:9']
			// 用一个小方块画出比例形状：长边固定、短边按比例算 —— 比纯文字快得多
			const ratioShape = (v, active) => {
				const c = active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'
				if (!v) {
					return h('span', {
						style: {
							display: 'inline-block', width: '16px', height: '16px', borderRadius: '3px',
							border: '1.5px solid ' + c, position: 'relative'
						}
					}, h('span', {
						style: {
							position: 'absolute', left: '3px', top: '7px', width: '10px', height: '1.5px',
							background: c, transform: 'rotate(-45deg)', transformOrigin: 'left center'
						}
					}))
				}
				const parts = String(v).split(':').map(Number)
				const a = parts[0]
				const b = parts[1]
				let w = 18
				let hh = 18
				if (a && b) {
					if (a >= b) { w = 22; hh = Math.max(6, Math.round(22 * b / a)) }
					else { hh = 22; w = Math.max(6, Math.round(22 * a / b)) }
				}
				return h('span', {
					style: {
						display: 'inline-block', width: w + 'px', height: hh + 'px',
						borderRadius: '3px', border: '1.5px solid ' + c,
						background: active ? c : 'transparent'
					}
				})
			}
			const doLibGenUpload = async (e) => {
				const f = (e.target.files || [])[0]
				e.target.value = ''
				if (!f) return
				libGenPatch({ uploadBusy: true })
				try {
					const data = f.size <= 1.5 * 1024 * 1024
						? await fileToDataUrl(f)
						: (await shrinkImage(f, 1600)).data
					const r = await apiPost('/api/workbench/image-assets',
						{ action: 'upload', name: f.name, data })
					if (!r.ok) throw new Error(r.error || '上传失败')
					libGenPatch({ upRel: r.relPath, upName: r.name, uploadBusy: false })
				} catch (err) {
					libGenPatch({ uploadBusy: false })
					flash(String((err && err.message) || err))
				}
			}
			const doLibGen = async () => {
				if (!libGen) return
				if (!libGen.prompt.trim()) { flash('先填提示词'); return }
				const preset = ((assetLib && assetLib.categories[libGen.catKey])
					&& assetLib.categories[libGen.catKey].presetLayout) || ''
				libGenPatch({ busy: true, error: '', relPath: '', jobId: null, saved: '' })
				try {
					const enq = await apiPost('/api/workbench/image-jobs', {
						action: 'enqueue',
						theme: libGen.prompt.trim(),
						// **不依赖风格库**：基准图是拿来做垫图参考的，画风由后续真正出图时决定。
						// 后端有对应的最小拼装路径（build_bare_prompt），不会硬塞一个默认风格。
						noStyle: true,
						layoutId: preset, mode: 'pure-image',
						ratio: libGen.ratio, withRef: true,
						assetImgs: libGen.upRel ? [libGen.upRel] : []
					})
					if (!enq.ok) throw new Error(enq.error || '入队失败')
					// ⚠️ 生成是**两步**：enqueue 只写库，真正跑起来要靠 image-run 拉起后台进程。
					// 少了这一步，任务会永远停在 queued —— 界面上看着"已提交"，
					// 而模型那边一个请求都没有。这个坑我踩过一次。
					const run = await apiPost('/api/workbench/image-run', { jobId: enq.job.id })
					if (!run.ok) throw new Error(run.error || '启动失败')
					libGenPatch({ busy: false, jobId: enq.job.id, startedAt: Date.now() })
					flash('已提交生成（约 30–50 秒）')
					await reload()
				} catch (err) {
					libGenPatch({ busy: false, error: String((err && err.message) || err) })
				}
			}
			const saveLibGen = async () => {
				if (!libGen || !libGen.relPath) return
				if (!libGen.name.trim()) { flash('给这个资产起个名字'); return }
				try {
					const r = await apiPost('/api/workbench/image-assets', {
						action: 'save', category: libGen.catKey,
						name: libGen.name.trim(), relPath: libGen.relPath
					})
					if (!r.ok) throw new Error(r.error || '归档失败')
					libGenPatch({ saved: (r.entry && r.entry.id) || '已存入' })
					flash('已存入' + (ASSET_LABEL[libGen.catKey] || '资产库'))
					await reloadAssets()
				} catch (err) { flash(String((err && err.message) || err)) }
			}
			// 出图后**自动归档进本库** —— 用户点「生成」就是要往库里加东西，
			// 再让他手工点一次「存入」是多余的一步，而且很容易忘（忘了就等于白生成）。
			// 失败不自动重试（saveErr 做闸），避免出错时反复打接口。
			React.useEffect(() => {
				if (!libGen || !libGen.relPath || !libGen.autoSave) return
				if (libGen.saved || libGen.saveErr || !libReady) return
				const nm = (libGen.name || '').trim() || ('基准图-' + String(libGen.jobId || ''))
				const rel = libGen.relPath
				apiPost('/api/workbench/image-assets',
					{ action: 'save', category: libGen.catKey, name: nm, relPath: rel })
					.then((r) => {
						if (!r.ok) throw new Error(r.error || '归档失败')
						setLibGen((cur) => (cur && cur.relPath === rel)
							? Object.assign({}, cur, { saved: (r.entry && r.entry.id) || '已存入' }) : cur)
						flash('已自动存入' + (ASSET_LABEL[libGen.catKey] || '资产库'))
						return reloadAssets()
					})
					.catch((e) => {
						setLibGen((cur) => (cur && cur.relPath === rel)
							? Object.assign({}, cur, { saveErr: String((e && e.message) || e) }) : cur)
					})
			}, [libGen, libReady, reloadAssets])

			// 生成中的秒表：让「生成中」不是一个静止的方块，用户能看出它在走
			const [libGenTick, setLibGenTick] = React.useState(0)
			React.useEffect(() => {
				if (!libGen || !libGen.jobId || libGen.relPath || libGen.error) return undefined
				const t = window.setInterval(() => setLibGenTick((x) => x + 1), 1000)
				return () => window.clearInterval(t)
			}, [libGen])

			const doRemoveLibAsset = async (it, catKey) => {
				if (!window.confirm('从' + (ASSET_LABEL[catKey] || '资产库') + '删除这个资产？\n\n' +
					it.id + '　' + (it.name || '') +
					'\n\n图库目录里的文件会一并删除（由技能自带的 delete_asset 执行），不可恢复。')) return
				try {
					const r = await apiPost('/api/workbench/image-assets',
						{ action: 'remove', id: it.id })
					if (!r.ok) throw new Error(r.error || '删除失败')
					flash('已删除 ' + it.id)
					await reloadAssets()
				} catch (err) { flash(String((err && err.message) || err)) }
			}
			// 下载资产为 PNG。资产文件存的是 webp，这里用 canvas 重绘一遍再导出 PNG。
			// 同源请求不会污染 canvas，所以 toBlob 可用；用 Image + ObjectURL 而非
			// createImageBitmap，是为了兼容旧内核（下载是低频操作，不值得省这点代码）。
			const downloadPng = async (it) => {
				try {
					const res = await fetch(imgUrl(it))
					if (!res.ok) throw new Error('取图失败 HTTP ' + res.status)
					const srcUrl = URL.createObjectURL(await res.blob())
					const img = new Image()
					await new Promise((resolve, reject) => {
						img.onload = resolve
						img.onerror = () => reject(new Error('图片解码失败'))
						img.src = srcUrl
					})
					const cv = document.createElement('canvas')
					cv.width = img.naturalWidth
					cv.height = img.naturalHeight
					cv.getContext('2d').drawImage(img, 0, 0)
					URL.revokeObjectURL(srcUrl)
					const png = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'))
					if (!png) throw new Error('PNG 编码失败')
					const outUrl = URL.createObjectURL(png)
					const a = document.createElement('a')
					a.href = outUrl
					a.download = (it.id || 'asset') + (it.name ? '-' + it.name : '') + '.png'
					document.body.appendChild(a)
					a.click()
					a.remove()
					setTimeout(() => URL.revokeObjectURL(outUrl), 5000)
					flash('已下载 PNG · ' + cv.width + '×' + cv.height)
				} catch (err) {
					flash('下载失败：' + String((err && err.message) || err))
				}
			}
			const doMount = async () => {
				const p = mountPath.trim() || libDefaultDir
				if (!p) { flash('请填一个图库目录'); return }
				setMountBusy(true)
				try {
					const r = await apiPost('/api/workbench/image-assets', { action: 'init', path: p })
					if (!r.ok) throw new Error(r.error || '挂载失败')
					flash('已挂载图库目录：' + ((r.library && r.library.dir) || p))
					setMountPath('')
					await reloadAssets()
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally { setMountBusy(false) }
			}
			/**
			 * 图库目录挂载面板。
			 * 同一个小面板放在**两个用到自建资产的地方**（漫图创作的分组④、存入资产库的抽屉）——
			 * 之前这里只有一句「挂载入口在生成模块统一设置」，而那个入口从来没建过，
			 * 用户被卡在「存不进去、也不知道去哪挂」中间。**提示必须指向真实存在的东西。**
			 */
			const mountPanel = () => h('div', {
				style: {
					border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: '10px',
					padding: '11px 12px', marginBottom: '9px',
					background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent)'
				}
			},
				h('div', { style: { fontSize: '12.5px', fontWeight: 650, marginBottom: '5px' } }, '第一步：挂载图库目录'),
				h('p', { style: Object.assign({}, IS.meta, { marginBottom: '8px' }) },
					'自建资产（角色 / 道具 / 场景）存在一个**外部图库目录**里，归档时会把图转成 webp 写进去、' +
					'同步镜像并刷新索引。目录还没挂载，所以「确认存入」用不了。填一个目录即可（不存在会自动创建）。'),
				h('div', { style: IS.rowWrap },
					h('input', {
						style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '330px' }),
						value: mountPath,
						placeholder: libDefaultDir ? ('留空则用 ' + libDefaultDir) : '图库目录的绝对路径',
						onChange: (e) => setMountPath(e.target.value)
					}),
					h('button', {
						type: 'button',
						style: Object.assign({}, IS.primary, mountBusy ? IS.primaryOff : null),
						onClick: doMount
					}, mountBusy ? '挂载中…' : '挂载')))

			/**
			 * 上传前在浏览器里压一道。
			 * 手机拍的 / 相机导出的商品图动辄 4–8MB，base64 之后还要再涨三成 ——
			 * 既可能顶到请求体上限，也没必要：生图接口用不到 4000px。
			 *
			 * ⚠️ 导出格式要跟着源格式走：PNG 直接转 JPEG 会把透明底**填成黑色**
			 * （canvas 的透明像素在 JPEG 里是黑的），商品抠图就毁了。
			 * 所以 PNG 仍导 PNG（保透明），其余导 JPEG。
			 */
			const shrinkImage = (file, maxSide) => new Promise((res, rej) => {
				const url = URL.createObjectURL(file)
				const img = new Image()
				img.onload = () => {
					try {
						const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
						const w = Math.max(1, Math.round(img.width * scale))
						const h = Math.max(1, Math.round(img.height * scale))
						const cv = document.createElement('canvas')
						cv.width = w
						cv.height = h
						cv.getContext('2d').drawImage(img, 0, 0, w, h)
						const isPng = /png/i.test(file.type)
						const data = isPng ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.9)
						URL.revokeObjectURL(url)
						res({ data, w, h, resized: scale < 1 })
					} catch (err) { URL.revokeObjectURL(url); rej(err) }
				}
				img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('图片解码失败')) }
				img.src = url
			})
			const fileToDataUrl = (f) => new Promise((res, rej) => {
				const r = new FileReader()
				r.onload = () => res(String(r.result))
				r.onerror = () => rej(new Error('读取文件失败'))
				r.readAsDataURL(f)
			})

			/**
			 * 本次上传参考图。
			 * 与「存入资产库」是**两件事**：这里只落盘到工作区临时目录，不进图库、不进索引、
			 * 不出现在挑选器里。电商单品图这种「就用这一次」的素材不该污染长期资产库。
			 */
			const onPickFiles = async (e) => {
				const files = Array.from(e.target.files || [])
				e.target.value = ''                    // 同一个文件连选两次也要能再次触发
				if (!files.length) return
				setUploadBusy(true)
				try {
					for (const f of files.slice(0, 6)) {
						if (!/^image\//.test(f.type)) continue
						// 小图原样传（保住原始格式与透明通道）；大图先压到 1600px 再传
						let data
						if (f.size <= 1.5 * 1024 * 1024) {
							data = await fileToDataUrl(f)
						} else {
							const s = await shrinkImage(f, 1600)
							data = s.data
						}
						const r = await apiPost('/api/workbench/image-assets',
							{ action: 'upload', name: f.name, data })
						if (!r.ok) throw new Error(r.error || '上传失败')
						setUploads((cur) => cur.concat([{ relPath: r.relPath, name: r.name, bytes: r.bytes }]))
					}
					flash('已加入本次参考图（不进资产库）')
				} catch (err) {
					flash(String((err && err.message) || err))
				} finally { setUploadBusy(false) }
			}

			const saveToLibrary = async () => {
				if (!saveTarget) return
				if (!libReady) { flash('先在下面挂载图库目录，才能存入自建资产'); return }
				const name = saveName.trim()
				if (!name) { flash('给这个资产起个名字'); return }
				setAssetBusy(true)
				try {
					const r = await apiPost('/api/workbench/image-assets',
						{ action: 'save', category: saveCat, name, relPath: saveTarget.rel_path })
					if (!r.ok) throw new Error(r.error || '归档失败')
					flash('已存入' + ASSET_LABEL[saveCat] + '：' + ((r.entry && r.entry.id) || ''))
					setSaveTarget(null)
					setSaveName('')
					await reloadAssets()
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally { setAssetBusy(false) }
			}

			const useAsset = (it) => {
				setAssetRefs((cur) => {
					const hit = cur.some((x) => x.id === it.id)
					const next = hit ? cur.filter((x) => x.id !== it.id) : cur.concat([it])
					flash(hit ? ('已移出垫图：' + it.id) : ('已加入垫图：' + it.id + ' ' + (it.name || '')))
					return next
				})
			}
			// 打开挑选器时清掉上次的搜索与分类：换一个库还留着上次的筛选条件，会让人以为库是空的
			const openPicker = (k) => { setPicker(k); setPickQ(''); setPickGroup('') }
			const closePicker = () => { setPicker(null); setPickQ(''); setPickGroup('') }
			const toggleMood = (m) => setMoods((cur) =>
				cur.includes(m) ? cur.filter((x) => x !== m) : cur.concat([m]))
			// 自定义情绪：**技能允许用户明确指定**（「除非用户在需求中明确指定了情绪词」），
			// 被禁的是 AI 自作主张生造非标复合长句（技能原文点了名：
			// 「压抑、肃杀、孤注一掷的狂暴史诗感与生存觉醒」）。
			// 所以这里放开输入，但保留 15 个预设作为默认口径。
			const addMood = () => {
				const v = moodInput.trim().replace(/[，,、\s]+$/, '')
				if (!v) return
				if (moods.includes(v)) { setMoodInput(''); return }
				setMoods((cur) => cur.concat([v]))
				setMoodInput('')
			}
			// 智能随机抽卡：全库随机，不做「主题→风格」的静态映射（技能规范严禁那种死映射）
			const randomPick = () => {
				const pickOne = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)
				const st = pickOne(catalog && catalog.styles)
				const la = pickOne(catalog && catalog.layouts)
				const co = pickOne(catalog && catalog.colors)
				setSel({ style: st, layout: Math.random() < 0.35 ? la : null, color: Math.random() < 0.5 ? co : null })
				// 融合模式下，场景风格也一起抽 —— 而且**刻意抽一个不同的**：
				// 同一种风格做角色和场景没有融合可言，技能明确要求两套视觉语言可辨
				let sc = ''
				if (fusionOn) {
					const pool = (catalog.styles || []).filter((x) => !st || x.id !== st.id)
					const s2 = pickOne(pool)
					if (s2) { sc = s2.id; setSceneStyle(s2.id) }
				}
				flash('已随机抽卡：' + (st ? st.id : '') + (la ? ' + ' + la.id : '') +
					(co ? ' + ' + co.id : '') + (sc ? ' + 场景 ' + sc : ''))
			}
			const clearAll = () => {
				setSel({ style: null, color: null, layout: null })
				setAssetRefs([])
				setMoods([])
				setRatio('')
				setWhitespace('')
				setSceneStyle('')
				flash('已清空选择')
			}

			const makeNewAsset = (catKey) => {
				// 原地开抽屉，**不跳去漫图创作** —— 这里只做"出一张基准图"这一件事，
				// 切页会把「填→生成→存」这条短链路拉成两段。
				// 角色有专属图型 IP-002（三视图基准图），道具/场景没有 —— 由生成逻辑按库自动带上。
				openLibGen(catKey)
			}

			const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length
			// 漫画流跑批时也要快轮询 —— 否则分镜板要等 60 秒才更新一次
			const seriesRunning = !!(series && (series.status === 'running' || series.status === 'queued'))
			const busyPoll = pending > 0 || seriesRunning
			React.useEffect(() => {
				// 有任务在跑就快轮询；空闲时慢一点——每次轮询要起几个 Python 进程，别空转
				const ms = busyPoll ? 4000 : 60000
				const t = window.setInterval(() => {
					reload()
					if (busyPoll) reloadSeries()
				}, ms)
				return () => window.clearInterval(t)
			}, [busyPoll, reload, reloadSeries])

			// 放大预览：点任意出图都能看大图（分镜板里的小图也要能放大，否则细节没法看）
			const openLightbox = (src, title, sub) => { setLightbox({ src, title, sub }) }
			const closeLightbox = () => setLightbox(null)
			React.useEffect(() => {
				if (!lightbox) return undefined
				const onKey = (e) => { if (e.key === 'Escape') closeLightbox() }
				window.addEventListener('keydown', onKey)
				return () => window.removeEventListener('keydown', onKey)
			}, [lightbox])

			const copy = async (text) => {
				if (!text) return
				try {
					await navigator.clipboard.writeText(text)
					flash('已复制')
				} catch (e) {
					flash('复制失败，请手动选择')
				}
			}

			// 出图请求体：preview 与 enqueue 共用同一份，避免两处参数漂移
			const genPayload = () => {
				const m = OUTPUT_MODES.find((x) => x.v === outMode) || OUTPUT_MODES[0]
				return {
					theme,
					styleId: sel.style && sel.style.id,
					colorId: sel.color && sel.color.id,
					layoutId: (sel.layout && sel.layout.id) || '',
					mode: m.skill,                    // 技能只认 pure-image / graphic-text
					outMode: outMode,                 // 出图模式（六选一）：资产库要按它筛选，必须存下来
					constraint: [
						m.extra,
						// 拍摄类型并进「构图要求」：它和出图模式带出的场景约束是同一层的东西。
						// 不新开字段 —— 多一个参数就要同步改 CLI、路由、DB 三处，不值。
						(outMode === 'photography' && photoType) ? ('拍摄类型：' + photoType) : '',
						// 画面文字语言也走这里：它同样是"场景层约束"，不是技能参数
						(TEXT_LANGS.find((x) => x.v === textLang) || {}).extra || ''
					].filter(Boolean).join('；'),
					fusionOn,
					sceneStyle: fusionOn ? sceneStyle : '',
					textLayout: (TEXT_LAYOUTS.find((x) => x.v === textLayout) || {}).extra || '',
					ratio,
					whitespace,
					mood: moods.join('、'),
					assetImgs: assetRefs.map((r) => r.img).filter(Boolean)
						.concat(uploads.map((u) => u.relPath)),
					// 融合模式下 withRef 仍给 true —— 它的实际语义是「用**实发版**提示词」
					// （sendZh，带资产一致性块），因为融合本来就没有编号参考图可垫。
					// 执行端若把 withRef 理解成「必须解析到参考图」，融合任务会自己把自己拦死。
					withRef
				}
			}
			// 切模式时把该模式对应的画幅/留白带进来（之后用户仍可改）
			const applyOutMode = (v) => {
				const m = OUTPUT_MODES.find((x) => x.v === v)
				if (!m) return
				setOutMode(v)
				setRatio(m.ratio)
				setWhitespace(m.ws)
				flash(m.ratio
					? ('已切到「' + m.label + '」，画幅预设 ' + m.ratio + '（可改）')
					: ('已切到「' + m.label + '」'))
			}

			const doPreview = async (layoutOverride) => {
				// 必填先自己查一遍。**不要**把一个「参数没填」变成一条后端报错：
				// 后端只会说「the following arguments are required: --theme」，
				// 而用户需要知道的是「画面主题没填」——而且这种错误以前还会退化成一条命令行（见 execPython 的注释）。
				if (!styleReady) { flash('先选一个风格编号'); goTab('风格库'); return }
				if (fusionOn && !sceneStyle.trim()) { flash('风格融合要先选（或写）「场景风格」'); return }
				if (createMode === 'comic' ? !sourceText.trim() : !theme.trim()) {
					flash(createMode === 'comic' ? '先贴漫画文案再预览' : '先填画面主题再预览')
					return
				}
				try {
					// layoutOverride：从图型库的抽屉里点「按当前组合预览」时，
					// 用抽屉里那个图型，而不是生成页已选的
					const body = genPayload()
					if (layoutOverride !== undefined) body.layoutId = (layoutOverride && layoutOverride.id) || ''
					const d = await apiPost('/api/workbench/image-jobs', Object.assign({ action: 'preview' }, body))
					if (!d.ok) throw new Error(d.error || '组词失败')
					setDecision(d.decision || null)
					setPromptModal(Object.assign({ ok: true }, d))
				} catch (e) {
					// 失败也走弹窗：底部 toast 放不下长文本，而组词失败的原因往往正是长文本
					setPromptModal({ ok: false, error: String((e && e.message) || e) })
				}
			}

			// 打开图型详情时按需拉它的完整原文（161 个图型共 165 KB，不塞进首屏索引）
			const openDrawer = (it) => {
				setDrawer(it)
				setLayoutDoc(null)
				if (it && it.kind === 'layout') {
					apiGet('/api/workbench/image-catalog?layout=' + encodeURIComponent(it.id))
						.then((d) => setLayoutDoc(d && d.ok ? d : { ok: false, error: (d && d.error) || '读不到图型原文' }))
						.catch((e) => setLayoutDoc({ ok: false, error: String((e && e.message) || e) }))
				}
			}

			/**
			 * 电商详情页多图：**一次出一整组**。
			 * 详情页本来就是多图的（主图/场景/卖点/细节/参数…），一张张做效率太低。
			 * 拆解配方 = 技能自带的 EC 图型序列（见 EC_RECIPE），每个分镜带**自己的图型**。
			 */
			const doEcPreview = () => {
				const shots = ecShots(ecCount)
				setSeriesPreview({
					panels: shots.map((s, i) => '第 ' + (i + 1) + ' 张　' + s.layoutId + ' ' + s.label + ' —— ' + s.intent),
					meta: { produced: shots.length, source: 'recipe', auto: false }
				})
			}
			const doEcBatch = async () => {
				if (!styleReady) { flash('先选一个风格'); goTab('风格库'); return }
				if (!theme.trim()) { flash('先填商品信息'); return }
				setBusy(true)
				try {
					const info = theme.trim().replace(/[。.\s]+$/, '')
					// 挂了人物参考图时，**逐张说明这张要不要人** —— 否则模型会把所有参考图
					// 都当产品参考，于是一组详情图里一个人都不出现（实测踩过）。
					const hasPerson = assetRefs.some((r) => String(r.id || '').startsWith('CH-'))
					const panels = ecShots(ecCount).map((s) => ({
						layoutId: s.layoutId,
						// 商品信息 + 本张要做什么：图型原文提供版式，这句提供"这一张的重点"
						text: info + '｜本张分镜：' + s.label + '（' + s.intent + '）'
							+ (hasPerson
								? (s.person
									? '｜本张**需要出现人物**：必须是所附人物参考图里的同一个人（同一张脸、同一发型、同一套服装），不要另造模特'
									: '｜本张**不需要出现人物**，只有商品本身')
								: '')
					}))
					const body = Object.assign({
						action: 'create', title: '电商详情页 · ' + info.slice(0, 24),
						sourceText: theme.trim(), panels
					}, genPayload())
					body.layoutId = ''          // 每张图型都不同，系列上不能挂一个统一的
					const created = await apiPost('/api/workbench/image-series', body)
					if (!created.ok) throw new Error(created.error || '创建失败')
					const run = await apiPost('/api/workbench/image-series',
						{ action: 'run', seriesId: created.seriesId })
					if (!run.ok) throw new Error(run.error || '启动失败')
					flash('已开始生成 ' + created.panelCount + ' 张详情页图（' +
						created.panelCount + ' 张按张计费）')
					await reloadSeries()
					await reload()
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally { setBusy(false) }
			}
			// 漫画流与电商详情页多图共用右侧的「分镜板」
			const batchMode = createMode === 'comic' || (outMode === 'ecommerce' && ecMulti)

			const doGenerate = async () => {
				if (!styleReady) { flash('先选一个风格编号'); goTab('风格库'); return }
				if (fusionOn && !sceneStyle.trim()) { flash('风格融合要先选（或写）「场景风格」'); return }
				// 电商图：商品图是必需的。
				// 这个模式存在的意义就是「照着你的商品出图」；没有商品图它会退化成普通的纯图模式，
				// 那用户选它就没有意义了。自建资产里的道具/场景也算 —— 可复用的商品就该从库里来。
				if (outMode === 'ecommerce' && !uploads.length && !assetRefs.length) {
					flash('电商图模式需要商品图：上传一张，或从自建资产里选一个道具（想凭空画商品请用「纯图」）')
					return
				}
				// 漫画流：一段文案拆成 N 个分镜，各出一张
				if (createMode === 'comic') { await doComic(); return }
				// 电商详情页多图：一次出一整组（每张图型不同）
				if (outMode === 'ecommerce' && ecMulti) { await doEcBatch(); return }
				if (!theme.trim()) { flash('先填画面主题'); return }
				// 分步精修：先给出完整提示词让人确认，不直接花掉一次出图
				if (createMode === 'stepwise') { await doPreview(); return }
				setBusy(true)
				try {
					const enq = await apiPost('/api/workbench/image-jobs',
						Object.assign({ action: 'enqueue', arms, size: size || undefined }, genPayload()))
					if (!enq.ok) throw new Error(enq.error || '入队失败')
					const run = await apiPost('/api/workbench/image-run', { jobId: enq.job.id })
					if (!run.ok) throw new Error(run.error || '启动失败')
					setPreviewJobId(enq.job.id)      // 预览区改成显示**这一次**的产出
					flash('已开始生成（约 30–70 秒）')
					await reload()
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally {
					setBusy(false)
				}
			}

			const rerun = async (job) => {
				setBusy(true)
				try {
					// 漫画流的分镜任务：**重跑它自己**。
					// 不能走下面的「新建独立任务」——分镜卡读的是系列里那条记录，
					// 新建的任务跟那张卡没有任何关系，现象就是「队列里在生成、
					// 卡片还写着失败」（实测 #93：series_id=None，跟 #12 那组无关）。
					// image-take 不检查原状态，所以失败的任务可以直接再跑。
					if (job.series_id) {
						const run = await apiPost('/api/workbench/image-run', { jobId: job.id })
						if (!run.ok) throw new Error(run.error || '启动失败')
						setPreviewJobId(job.id)
						flash('已重跑第 ' + (job.panel_index || '?') + ' 镜（#' + job.id + '）')
						await reload()
						// 分镜板的状态来自系列查询，不一并刷新的话卡片还是「失败」
						await reloadSeries()
						return
					}
					let p = {}
					try { p = JSON.parse(job.params_json || '{}') } catch (e) { p = {} }
					// 把原来的垫图带过去。任务里存的是**绝对路径**，而 assetImgs
					// 本来就支持绝对路径（node 半 isAbsolute 分支会原样用，并做越界与存在性检查）。
					// 这里以前发的是空数组，配着一条说「直接走 assetRefPaths」的注释 ——
					// 而 enqueue 路由根本没有 assetRefPaths 这个字段，于是重跑一律丢垫图，
					// 人物长相跟着变。注释和代码说的不是一回事，以代码为准修掉。
					let refs = []
					try { refs = JSON.parse(job.asset_ref_path || '[]').filter(Boolean) } catch (e) { refs = [] }
					const enq = await apiPost('/api/workbench/image-jobs', {
						action: 'enqueue', theme: job.theme, styleId: job.style_id,
						colorId: job.color_id, layoutId: job.layout_id,
						withRef: !!job.with_ref, arms: job.arms, size: job.size,
						mode: p.mode, ratio: p.ratio, whitespace: p.whitespace,
						mood: p.mood, textReq: p.textReq, redraw: p.redraw,
						// 其余场景层参数一并转发。以前只转 6 个，
						// subject / constraint / textLayout / outMode 全丢 ——
						// 而**人物锚点就存在 constraint 里**，丢了它重跑的图长相必然变。
						subject: p.subject, constraint: p.constraint,
						textLayout: p.textLayout, outMode: p.outMode,
						assetImgs: refs
					})
					if (!enq.ok) throw new Error(enq.error || '入队失败')
					const run = await apiPost('/api/workbench/image-run', { jobId: enq.job.id })
					if (!run.ok) throw new Error(run.error || '启动失败')
					setPreviewJobId(enq.job.id)
					flash('已重跑 #' + enq.job.id)
					await reload()
				} catch (e) { flash(String((e && e.message) || e)) } finally { setBusy(false) }
			}

			if (catError) {
				return h('div', { style: S.page },
					h('div', { style: IS.flexCol },
						h('div', { style: S.head }, h('h1', { style: S.h1 }, '生图工作台')),
						h('div', { style: S.body },
							h('div', { style: S.err }, '读不到风格库：' + catError +
								'\n技能应装在 <DSH_HOME>/skills/handraw-style，可用 DSH_WORKBENCH_SKILL_ROOT 覆盖。'))))
			}
			if (!catalog) {
				return h('div', { style: S.page }, h('div', { style: S.empty }, '正在读取风格库…'))
			}

			// ── 四个画廊：各自是独立模块 ──
			//    四种不同的资产，共用同一套浏览/筛选/详情交互，但各自是独立入口。
			//    合并成一个带子切换的页会让人以为只做了第一个——第一版就是这么被误会的。
			const GALLERIES = [
				{ mod: '风格库', kind: 'style', key: 'styles', unit: '种手绘风格',
				  note: '技能契约里的 001–324 是全局序号，卡片上的 ID 是组内编号（如 257 → FE-059）。纯数字按编号精确搜。' },
				{ mod: '图型库', kind: 'layout', key: 'layouts', unit: '种排版图型',
				  note: '**图型是排版模板**：每种给一套构图与版式，选中后其原文会逐字拼进提示词，出图就按这个排版来。不是创作案例展示。' },
				{ mod: '主色调', kind: 'color', key: 'colors', unit: '种经典单色',
				  note: '选中后写进提示词的「主题色」段；每个色自带中英文名与一句调性说明。' }
			]
			// 角色 / 道具 / 场景不走画廊：它们不是只读预置库，而是可增可改的**资产库**
			// （出图时作为垫图引用，保证跨媒介形象不漂移），所以单独一个模块。
			const ASSET_MOD = '角色资产库'
			const ASSET_CATS = ['characters', 'props', 'scenes']
			const GAL_BY_MOD = {}
			GALLERIES.forEach((g) => { GAL_BY_MOD[g.mod] = g })
			const curGal = GAL_BY_MOD[mod] || null

			// 图型分组在数据里是英文 slug，翻成中文；风格分组取「/」前的中文段
			const GROUP_ZH = {
				'social-card': '社媒卡', infographic: '信息图', 'comic-storyboard': '漫画分镜',
				'ip-character': 'IP 角色', ecommerce: '电商图'
			}
			const groupLabel = (it) => (it.kind === 'layout'
				? (GROUP_ZH[it.groupKey] || it.groupKey)
				: String(it.group || it.groupKey || '').split(' / ')[0])

			const pick = (it, slot) => {
				setSel((cur) => {
					const next = Object.assign({}, cur)
					next[slot] = (cur[slot] && cur[slot].id === it.id) ? null : it
					return next
				})
				if (slot === 'style') flash('已选风格 ' + (it.legacy ? '#' + it.legacy + '（' + it.id + '）' : it.id))
				if (slot === 'color') flash('已选主题色 ' + it.id)
				if (slot === 'layout') flash('已选图型 ' + it.id)
			}
			const slotOf = (it) => (it.kind === 'layout' ? 'layout' : it.kind === 'color' ? 'color' : 'style')
			const isPicked = (it) => {
				const s = sel[slotOf(it)]
				return !!(s && s.id === it.id)
			}
			const imgUrl = (it, from) => '/api/workbench/image-asset?p=' +
				encodeURIComponent(it.img) + '&from=' + (from || 'skill')

			// ── 画廊（风格 / 图型 / 主题色 / 角色 四个子库） ──
			// ── 画廊 / 挑选器共用的筛选 ──
			// **判定逻辑只写一份**：画廊页与挑选抽屉共用，避免两套语义漂移。
			// 尤其是「纯数字按编号精确搜」这条 —— 写两遍迟早有一遍忘改。
			const groupOptions = (all) => {
				const out = []
				all.forEach((it) => {
					if (!out.some((x) => x.k === it.groupKey)) {
						out.push({ k: it.groupKey, label: groupLabel(it) })
					}
				})
				return out
			}
			// 搜索语义分两种，别混：
			//   · 纯数字（可带 #）= 按编号**精确**搜，且**只认 legacy**。
			//     018 是全局唯一的 #018（FA-018），但 -018 在 8 个组里各有一个，
			//     拿组内序号兜底会一次返回 7 条（实测）。想按组内编号找就写完整 ID。
			//   · 其它 = 模糊搜（ID / 编号 / 名称 / 作者 / 关键词）。
			const filterItems = (all, kind, qq, grp) => {
				const kw = String(qq || '').trim().replace(/^[#＃]/, '').toLowerCase()
				const isNumQuery = /^\d{1,3}$/.test(kw)
				return all.filter((it) => {
					if (grp && it.groupKey !== grp) return false
					if (!kw) return true
					if (isNumQuery && kind === 'style') return it.legacy === kw.padStart(3, '0')
					const hay = [it.id, it.legacy, it.name, it.nameEn, it.author, it.traits,
						(it.keywords || []).join(' ')].filter(Boolean).join(' ').toLowerCase()
					return hay.replace(/[\s-]/g, '').includes(kw.replace(/[\s-]/g, ''))
				})
			}

			// 一个画廊模块的视图。三个 tab 共用这套浏览/筛选/详情，只有数据与文案不同。
			const galleryView = (g) => {
				const all = catalog[g.key] || []
				const groups = groupOptions(all)
				const visible = filterItems(all, g.kind, q, group)
				const kwHit = String(q || '').trim().replace(/^[#＃]/, '').toLowerCase()
				const numHit = (/^\d{1,3}$/.test(kwHit) && g.kind === 'style' && visible.length === 1)
					? visible[0].legacy + ' → ' + visible[0].id : ''
				return h('div', { style: IS.flexCol },
					h('div', { style: S.head },
						h('h1', { style: S.h1 }, g.mod),
						h('p', { style: S.sub }, all.length + ' ' + g.unit + '。' + g.note),
						h('input', {
							style: S.search,
							placeholder: g.kind === 'style'
								? '按编号搜（如 257 / #18 / FA-018），或搜名称、作者、关键词…'
								: '搜索名称 / 编号 / 关键词…',
							value: q, onChange: (e) => setQ(e.target.value)
						}),
						numHit ? h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
							'编号 ' + numHit + '（001–324 是全局序号，卡片上的 ID 是组内编号）') : null,
						h('div', { style: IS.subTabs },
							h('span', { style: Object.assign({}, IS.meta, { alignSelf: 'center', marginRight: '2px' }) }, '查看：'),
							h('button', {
								type: 'button', style: Object.assign({}, IS.pill, group === '' ? IS.pillOn : null),
								onClick: () => setGroup('')
							}, '全部 ' + all.length),
							groups.map((x) => h('button', {
								key: x.k, type: 'button',
								style: Object.assign({}, IS.pill, group === x.k ? IS.pillOn : null),
								onClick: () => setGroup(x.k)
							}, x.label + ' ' + all.filter((it) => it.groupKey === x.k).length)))),
					h('div', { style: S.body },
						visible.length === 0
							? h('div', { style: S.empty }, '没有匹配的条目')
							: h('div', { style: IS.grid }, visible.map((it) => h('button', {
								key: it.id, type: 'button',
								style: Object.assign({}, IS.card, isPicked(it) ? IS.cardOn : null),
								onClick: () => openDrawer(it),
								onDoubleClick: () => pick(it, slotOf(it))
							},
								it.img
									? h('img', { style: IS.thumb, src: imgUrl(it), loading: 'lazy', alt: it.id })
									: h('div', { style: Object.assign({}, IS.thumb, { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' }) }, '无图'),
								h('div', { style: IS.name }, it.name || it.id),
								h('div', { style: IS.meta },
									it.legacy ? h('span', { style: IS.idBadge }, '#' + it.legacy + '　') : null,
									h('span', { style: IS.idBadge }, it.id),
									it.author ? ' · ' + it.author : ''),
								isPicked(it) ? h('span', { style: Object.assign({}, S.tag, { borderColor: 'currentColor' }) }, '已选') : null
							)))))
			}

			// ── 角色资产库（角色 / 道具 / 场景）──
			//    它不是只读画廊：这些基准图要在出图时当**垫图**用（保持主体一致），
			//    所以还要能往里加资产、并且能从生成物一键归档进来。
			const assetLibView = (() => {
				if (!assetLib) {
					return h('div', { style: IS.flexCol },
						h('div', { style: S.head }, h('h1', { style: S.h1 }, ASSET_MOD)),
						h('div', { style: S.body },
							assetErr
								? h('div', { style: S.err }, assetErr)
								: h('div', { style: S.empty }, '正在读取资产库…')))
				}
				const cats = assetLib.categories
				const cur = cats[assetCat] || cats.characters
				const lib = assetLib.library
				const catName = cur.label.replace('库', '')
				return h('div', { style: IS.flexCol },
					h('div', { style: S.head },
						h('h1', { style: S.h1 }, ASSET_MOD),
						h('p', { style: S.sub },
							'角色 / 道具 / 场景三类基准图。出图时作为垫图引用，保持主体形象一致、跨媒介不漂移。' +
							'库内所有资产都以纯参考图形式参与出图，所以不需要维护冗长的外观描述。'),
						// 图库目录的挂载入口**不放在这里**：它属于「生成模块统一设计」的一部分，
						// 这里只显示当前状态。（2026-10-07 按用户要求移出，未在生成模块里自造 UI。）
						lib.initialized
							? h('div', { style: Object.assign({}, IS.meta, { marginTop: '8px' }) },
								'图库目录：' + lib.dir)
							: null,
						h('div', { style: IS.subTabs },
							ASSET_CATS.map((k) => h('button', {
								key: k, type: 'button',
								style: Object.assign({}, S.tab, assetCat === k ? S.tabOn : S.tabOff),
								onClick: () => setAssetCat(k)
							}, cats[k].label + ' ' + cats[k].count)))),
					h('div', { style: S.body },
						assetErr ? h('div', { style: S.err }, assetErr) : null,
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, cur.label + '：怎么往里加资产'),
							cur.createHint
								? h('div', { style: Object.assign({}, IS.row, { marginBottom: '8px' }) },
									h('span', { style: IS.meta }, '① 出基准图（复制这句给 AI，或点右侧按钮）：'),
									h('code', { style: IS.code }, cur.createHint),
									h('button', { type: 'button', style: S.mini, onClick: () => copy(cur.createHint) }, '复制'))
								: null,
							h('div', { style: IS.row },
								h('span', { style: IS.meta }, (cur.createHint ? '② ' : '') + '归档到本库：'),
								h('code', { style: IS.code }, cur.saveHint),
								h('button', { type: 'button', style: S.mini, onClick: () => copy(cur.saveHint) }, '复制')),
							h('div', { style: Object.assign({}, IS.row, { marginTop: '10px' }) },
								h('button', { type: 'button', style: IS.primary, onClick: () => makeNewAsset(assetCat) },
									'生成新' + catName),
								h('span', { style: IS.meta },
									cur.presetLayout
										? ('会带入本库的预设图型 ' + cur.presetLayout + ' 并跳到生成页')
										: '本库没有预设图型，到生成页自己挑'))),
						cur.count === 0
							? h('div', { style: S.empty }, cur.label + '还是空的 —— 按上面两步加一个，或直接「生成新' + catName + '」。')
							: h('div', { style: IS.grid }, cur.items.map((it) => h('div', { key: it.id, style: IS.card },
								it.img
									? h('img', {
										style: Object.assign({}, IS.thumb, { cursor: 'zoom-in' }),
										src: imgUrl(it), loading: 'lazy', alt: it.id,
										// 卡片上的图直接点开看大图 —— 「查看大图」那个按钮要多走一步抽屉
										onClick: () => openLightbox(imgUrl(it), it.id + '　' + (it.name || ''),
											(it.tags || []).join(' · ') || '点击任意处关闭')
									})
									: h('div', { style: Object.assign({}, IS.thumb, { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' }) }, '无图'),
								h('div', { style: IS.name }, it.name || it.id),
								h('div', { style: IS.meta },
									h('span', { style: IS.idBadge }, it.id),
									it.isCustom ? ' · 自建' : ' · 官方预置',
									it.createdAt ? ' · ' + it.createdAt : ''),
								(it.tags || []).length
									? h('div', { style: IS.row },
										it.tags.map((t, i) => h('span', { key: 'tag' + i, style: S.tag }, t)))
									: null,
								h('div', { style: IS.row },
									// 有描述才给「详情」：官方预置资产没写描述，点了会是空弹层
									(it.desc || it.role || (it.facts || []).length)
										? h('button', {
											type: 'button', style: S.mini,
											onClick: () => setAssetDetail(it)
										}, '详情')
										: null,
									h('button', {
										type: 'button', style: S.mini,
										onClick: () => setDrawer(Object.assign({}, it, { kind: 'asset' }))
									}, '查看大图'),
									// 下载成 PNG（资产存的是 webp，前端 canvas 转码导出）
									h('button', {
										type: 'button', style: S.mini,
										onClick: () => downloadPng(it)
									}, '下载 PNG'),
									h('button', { type: 'button', style: S.mini, onClick: () => useAsset(it) }, '以此出图'),
									// 官方预置资产不给删（它们是技能自带的，删了下次更新又会回来；
									// 而且 delete_asset 只管自建库）——所以只对自建资产显示
									it.isCustom
										? h('button', {
											type: 'button', style: Object.assign({}, S.mini, { color: '#b42318' }),
											onClick: () => doRemoveLibAsset(it, assetCat)
										}, '删除')
										: null),
								(assetRefs.some((x) => x.id === it.id))
									? h('span', { style: Object.assign({}, S.tag, { borderColor: 'currentColor' }) }, '已作垫图')
									: null))))
				)
			})()

			// ── 生成：左表单 + 右渲染预览 ──
			//    布局与交互对齐参考产品：左侧一列分组卡片、底部固定主行动按钮、右侧渲染预览。
			//    分组内容按「技能提示词真正需要什么信息」来排（出图模式与留白 / 主题 /
			//    画幅与情绪 / 视觉资产与风格搭配），而不是照抄参考产品的字段。
			const RATIO_PRESETS = [
				{ label: '小红书/公众号贴图', v: '3:4' },
				{ label: '公众号封面', v: '2.35:1' },
				{ label: 'X 文章封面', v: '5:2' },
				{ label: '文章插图', v: '4:3' },
				{ label: '方块', v: '1:1' },
				{ label: '手机全屏', v: '9:16' }
			]
			const MOODS = ['治愈', '童趣', '松弛', '幽默', '诗意', '浪漫', '活力', '微丧',
				'孤寂', '紧张', '庄严', '荒诞', '恐怖', '神秘', '激烈']
			const WHITESPACES = ['正常', '适中', '多']
			// 自定义情绪（不在 15 个预设里的）要单独渲染，否则选中后看不见
			const customMoods = moods.filter((m) => MOODS.indexOf(m) < 0)
			const OUTPUT_MODES = [
				{ v: 'pure-image', label: '纯图', skill: 'pure-image', ratio: '', ws: '', extra: '' },
				{ v: 'graphic-text', label: '图文', skill: 'graphic-text', ratio: '', ws: '', extra: '' },
				{ v: 'poster', label: '海报', skill: 'graphic-text', ratio: '2:3', ws: '多',
				  extra: '海报构图：大标题与主视觉并重，信息层级清晰' },
				{ v: 'article-illustration', label: '文章插图', skill: 'pure-image', ratio: '4:3', ws: '', extra: '' },
				{ v: 'article-cover', label: '文章封面', skill: 'graphic-text', ratio: '2.35:1', ws: '',
				  extra: '封面构图：标题与主视觉协调，缩略图尺寸下仍能辨识' },
				{ v: 'photography', label: '摄影', skill: 'pure-image', ratio: '3:2', ws: '',
				  extra: '写实摄影质感：真实光影与材质，不要手绘笔触' },
				// 电商图**不是海报的子类**：海报技能的字段是「投放场景/受众/情感基调」（广告海报），
				// 技能里完全没有「商品/产品/主图」；而电商在图型层是独立一类（EC-001~EC-024 共 24 个）。
				// 所以这里单立一项：技能走纯图（EC 图型本来就不加图文后缀），默认 1:1 主图比例，
				// 并开放「商品图上传」作为主体参考。
				{ v: 'ecommerce', label: '电商图', skill: 'pure-image', ratio: '1:1', ws: '',
				  extra: '电商商品图：主体商品清晰突出、背景干净，第一眼看清商品' }
			]
			// 必填标记。**只标真正会拦住提交的字段** ——
			// 标了星号却不拦、或者拦了却不标星，两种都会让人不再信这个标记。
			const Req = () => h('span', {
				style: { color: '#d92d20', fontWeight: 700, marginRight: '3px' }, title: '必填'
			}, '*')
			const seg = (opts, cur, onPick) => h('div', { style: IS.seg },
				opts.map((o) => h('button', {
					key: String(o.v), type: 'button',
					style: Object.assign({}, IS.segBtn, cur === o.v ? IS.segOn : null),
					onClick: () => onPick(o.v)
				}, o.label)))
			const chipBtn = (label, on, onClick) => h('button', {
				key: label, type: 'button',
				style: Object.assign({}, IS.chip, on ? IS.chipOn : null), onClick
			}, label)
			const sec = (no, title, extra, kids) => h('div', { style: IS.sec },
				h('div', { style: IS.secHead }, h('span', { style: IS.secNo }, no),
					h('span', { style: { fontWeight: 650, fontSize: '13px' } }, title), extra || null),
				kids)
			const pickCard = (label, it, slotKey, hint, required) => h('button', {
				type: 'button', style: IS.pickCard, onClick: () => openPicker(slotKey)
			},
				it && it.img
					? h('img', { style: IS.pickThumb, src: imgUrl(it), loading: 'lazy', alt: it.id })
					: h('div', { style: Object.assign({}, IS.pickThumb, { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' }) }, hint),
				h('div', { style: IS.label }, required ? Req() : null, label + (it ? '' : '（未选）')),
				it ? h('div', { style: IS.name }, (it.legacy ? '#' + it.legacy + ' ' : '') + it.id) : null,
				it ? h('div', { style: IS.meta }, it.name || '') : h('div', { style: IS.meta }, '点击选择'))
			const dec = decision || {}
			// 预览区显示的是**这一次创作出来的那张**，而不是"全库最新的那张"。
			//
			// 之前写的是 assets[0]（最新生成物），结果：打开页面时左侧主题还是空的，
			// 右侧却摆着一张完整的成品图 —— 任何人都会以为"这是我当前设置生成的"。
			// 预览区回答的是"我这次做出来的东西长什么样"，不是"我最近做过什么"。
			// （历史回看是「我的创作」的职责，两处不该混。）
			const latest = previewJobId
				? assets.find((a) => a.job_id === previewJobId)
				: null
			// 预览区在**等出图**时也要有反馈 —— 否则它和"什么都没发生"长得一模一样：
			// 点了生成，左侧队列显示「生成中」，右侧还是一句"准备开始生成"，用户会以为没提交成功。
			const previewJob = previewJobId
				? jobs.find((j) => j.id === previewJobId)
				: null
			const previewRunning = !!(previewJob
				&& (previewJob.status === 'queued' || previewJob.status === 'running'))
			// 耗时直接用任务行的 created_at 算，不额外存 state（少一个可能不同步的来源）
			const previewStartedMs = (previewJob && previewJob.created_at)
				? new Date(String(previewJob.created_at).replace(' ', 'T')).getTime()
				: 0
			const previewElapsed = previewStartedMs
				? Math.max(0, Math.round((Date.now() - previewStartedMs) / 1000))
				: 0

			// ── 分镜板（漫画流右栏）──
			//   每镜一格：跑完就换成图，没跑完显示状态。图与分镜靠 job_id 对上。
			const comicPanels = (series && series.panels) || []
			const comicDone = (series && series.doneCount) || 0
			const panelAsset = {}
			;((series && series.assets) || []).forEach((a) => { panelAsset[a.job_id] = a })
			const comicBoard = h('div', { style: IS.previewBox },
				comicPanels.length === 0
					? h('div', { style: Object.assign({}, S.empty, { padding: '30px 0' }) },
						'还没有分镜。左侧选「漫画流」、贴一段文案，点「预览拆解」看看会被切成几镜。')
					: h('div', null,
						h('div', { style: IS.rowWrap },
							h('span', { style: Object.assign({}, S.tag, { borderColor: 'currentColor' }) },
								'漫画流 #' + (series && series.id)),
							h('span', { style: IS.meta }, '风格 ' + ((series && series.style_id) || '—')),
							h('span', { style: IS.meta }, comicDone + ' / ' + comicPanels.length + ' 完成'),
							(series && series.error)
								? h('span', { style: { fontSize: '11px', color: '#b42318' } }, series.error)
								: null),
						h('div', {
							style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px', marginTop: '10px' }
						}, comicPanels.map((p) => {
							const a = panelAsset[p.id]
							return h('div', {
								key: p.id,
								style: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', borderRadius: '10px', padding: '7px', background: 'var(--dsw-alias-bg-layer-1)' }
							},
								a
									? h('img', {
										style: { width: '100%', borderRadius: '7px', display: 'block', cursor: 'zoom-in' },
										src: '/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
										alt: 'panel-' + p.panel_index, loading: 'lazy',
										onClick: () => openLightbox(
											'/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
											'漫画流 #' + (series && series.id) + ' · 第 ' + p.panel_index + ' 镜',
											'点击看大图')
									})
									: h('div', {
										style: {
											width: '100%', aspectRatio: '1 / 1', borderRadius: '7px',
											background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)',
											display: 'flex', alignItems: 'center', justifyContent: 'center',
											fontSize: '11.5px', color: IS_STATUS_COLOR[p.status] || 'var(--dsw-alias-label-secondary)'
										}
									}, IS_STATUS_ZH[p.status] || p.status),
								h('div', { style: Object.assign({}, IS.meta, { marginTop: '6px', fontWeight: 600 }) },
									'第 ' + p.panel_index + ' 镜'),
								h('div', {
									style: {
										fontSize: '11px', lineHeight: '1.45', color: 'var(--dsw-alias-label-secondary)',
										display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden'
									}
								}, p.theme || ''))
						}))))
			// 图型会自动切图文模式（技能规范），显示要跟着走；出图模式本身是场景层，不改
			const modeDef = OUTPUT_MODES.find((x) => x.v === outMode) || OUTPUT_MODES[0]
			const effMode = sel.layout ? 'graphic-text' : modeDef.skill
			// 把技能的判定说成人话：这三种来源对应三种不同的出图策略
			const decisionText = (d) => {
				const src = (d && d.activation_source) || ''
				if (src === 'name+style') return '强激活：只给风格名就够 —— 不给特征词，也不需要垫图'
				if (src === 'name+style+traits') return '名称不够强：会附带核心特征词 —— 不需要垫图'
				if (src.indexOf('reference-image') >= 0) return '名称与特征词都不够强 —— 技能建议垫参考图'
				return src ? ('判定来源：' + src) : ''
			}
			// 风格融合：「角色风格」必须是编号；「场景风格」可以是编号，也可以直接写名称（如 写实）
			const isStyleId = (v) => /^[A-Za-z]{2}-\d{3}$/.test(String(v || '').trim())
			const sceneStyleLabel = () => {
				if (!sceneStyle) return { title: '未选', sub: '' }
				if (!isStyleId(sceneStyle)) {
					return { title: sceneStyle, sub: '自定义名称 · 按原样写入，不展开' }
				}
				const it = (catalog.styles || []).find((x) => x.id === sceneStyle)
				return {
					title: it ? ((it.legacy ? '#' + it.legacy + ' ' : '') + (it.name || it.id)) : sceneStyle,
					sub: sceneStyle + ' · 按生图方式完整展开'
				}
			}
			// 画幅 → 接口尺寸的提示。换算表来自后端索引（catalog.ratioToSize），
			// **不在 JS 里再抄一份** —— 抄一份就必然与后端漂移。
			const ratioSizeHint = (r) => {
				const v = String(r || '').trim().toLowerCase().replace(/\s/g, '')
				if (!v) return ''
				if (/^\d{2,5}x\d{2,5}$/.test(v)) return '直接按 ' + v + ' 请求'
				const hit = (catalog && catalog.ratioToSize && catalog.ratioToSize[v]) || ''
				if (!hit) return '接口认不出这个比例，将用配置默认尺寸'
				const approx = (catalog.ratioApprox || []).indexOf(v) >= 0
				return '接口按 ' + hit + ' 出图' + (approx ? '（最接近档，非精确比例）' : '')
			}
			const studioView = h('div', { style: IS.studio },
				h('div', { style: IS.formCol },
					h('div', { style: IS.rowWrap },
						seg([{ v: 'one-shot', label: '⚡ 一键生图' }, { v: 'stepwise', label: '✦ 分步精修' },
							{ v: 'comic', label: '🎬 漫画流' }],
							createMode, setCreateMode),
						h('span', { style: IS.meta },
							createMode === 'comic'
								? '一段文案拆成多镜，每镜各出一张'
								: (createMode === 'one-shot' ? '跳过提示词确认，直接出图' : '先给出完整提示词，确认后再出图')),
						h('span', { style: Object.assign({}, IS.meta, { marginLeft: 'auto' }) },
							Req(), '标星为必填')),

					sec('1', '出图模式与留白', null, [
						h('div', { style: IS.rowWrap },
							h('span', { style: IS.label }, '出图模式'),
							h('div', { style: IS.seg },
								OUTPUT_MODES.map((m) => h('button', {
									key: m.v, type: 'button',
									style: Object.assign({}, IS.segBtn, outMode === m.v ? IS.segOn : null),
									onClick: () => applyOutMode(m.v)
								}, m.label))),
							h('span', { style: IS.meta },
								'技能模式：' + (modeDef.skill === 'graphic-text' ? '图文' : '纯图'))),
						h('p', { style: Object.assign({}, IS.meta, { margin: '7px 0 9px' }) },
							modeDef.ratio
								? ('「' + modeDef.label + '」对应画幅 ' + modeDef.ratio + '，已带入下方第 3 组（可改）' +
									(modeDef.ws ? '；留白预设「' + modeDef.ws + '」' : ''))
								: (sel.layout ? '已选图型 → 技能会自动走图文模式' : '该模式不预设画幅，在第 3 组自由选择')),
						h('div', { style: IS.rowWrap },
							h('span', { style: IS.label }, '留白'),
							WHITESPACES.map((w) => chipBtn(w, whitespace === w,
								() => setWhitespace(whitespace === w ? '' : w))),
							h('span', { style: IS.meta }, '技能无此参数，走「附加约束」通道')),
						// 文字排布：只在图文模式有意义（纯图模式下画面本就不出现文字）
						h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '8px' }) },
							h('span', { style: IS.label }, '文字排布'),
							TEXT_LAYOUTS.map((t) => chipBtn(t.label, textLayout === t.v, () => {
								setTextLayout(t.v)
								// 选了具体的文字排布，就等于要图文 —— 自动把模式切过去，省一步
								if (t.v && modeDef.skill === 'pure-image' && !sel.layout) setOutMode('graphic-text')
							})),
							h('span', { style: IS.meta },
								effMode === 'graphic-text'
									? '技能无此参数，走「附加约束」通道'
									: '当前是纯图模式，选任一项会自动切到图文')),
						// 画面文字语言：一组图里模型会随机制中英文，不锁就中英混排
						h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '8px' }) },
							h('span', { style: IS.label }, '画面文字语言'),
							TEXT_LANGS.map((t) => chipBtn(t.label, textLang === t.v, () => setTextLang(t.v))),
							h('span', { style: IS.meta },
								'技能无此参数，走「附加约束」通道 · 一组图必须锁同一种语言，否则会中英混排'))
					]),

					sec('2', [Req(), createMode === 'comic' ? '漫画文案（按空行分段）'
						: (outMode === 'ecommerce' ? '商品信息（越详细越准）' : '画面主题与内容')],
						h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
							(createMode === 'comic' ? sourceText.length : theme.length) + ' / 3000'), [
						// 电商图：单张 or 详情页多图。详情页本来就是多图的，一张张做效率太低。
						outMode === 'ecommerce' && createMode !== 'comic'
							? h('div', { style: Object.assign({}, IS.rowWrap, { marginBottom: '9px' }) },
								h('span', { style: IS.label }, '出图数量'),
								seg([{ v: false, label: '单张主图' }, { v: true, label: '详情页多图' }],
									ecMulti, (v) => { setEcMulti(v); setSeriesPreview(null) }),
								ecMulti
									? h('div', { style: IS.seg },
										h('button', {
											type: 'button', style: IS.segBtn,
											onClick: () => setEcCount(Math.max(2, ecCount - 1))
										}, '−'),
										h('span', { style: { minWidth: '34px', textAlign: 'center', fontWeight: 650, fontSize: '12.5px' } },
											String(ecCount)),
										h('button', {
											type: 'button', style: IS.segBtn,
											onClick: () => setEcCount(Math.min(EC_RECIPE.length, ecCount + 1))
										}, '+'))
									: null,
								ecMulti
									? h('button', { type: 'button', style: S.mini, onClick: doEcPreview }, '预览拆解')
									: null,
								h('span', { style: IS.meta },
									ecMulti
										? '按技能自带的电商图型序列出 ' + ecCount + ' 张'
										: '只出一张（主图）'))
							: null,
						h('textarea', {
							style: Object.assign({}, S.textarea,
								createMode === 'comic' ? { minHeight: '170px' }
									: (outMode === 'ecommerce' ? { minHeight: '140px' } : null)),
							value: createMode === 'comic' ? sourceText : theme,
							maxLength: 3000,
							placeholder: createMode === 'comic'
								? '贴一段文章、一句话或一句金句。按空行分段 —— 每段默认就是一镜。'
								: outMode === 'ecommerce'
									? '例：316 不锈钢轻量保温杯，500ml，杯身磨砂，杯盖食品级 PP，24 小时保温，'
										+ '净重 280g，通勤/健身适用，四色可选。\n'
										+ '（越详细越准：规格给参数图、卖点给卖点图、场景给场景图 —— 点下面「怎么写」看全貌）'
									: '例：秋天的夕阳，一个人坐在河堤上看远处亮起的路灯',
							onChange: (e) => (createMode === 'comic'
								? setSourceText(e.target.value) : setTheme(e.target.value))
						}),
						// 「帮我润色主题」：**只给建议，不自动替换**。
						// 技能明文要求逐字保留主题（Do not expand, paraphrase, interpret, or add），
						// 自动改写会破坏「我写的 → 出图结果」这条对应关系。
						// 但把「受众: … 业务场景: …」这类需求说明当主题发出去，模型只能瞎猜画面 ——
						// 所以给一个**显式、可拒绝**的改写入口。漫画流不走这条（它按空行分段当分镜）。
						createMode !== 'comic'
							? h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '8px' }) },
								h('button', {
									type: 'button',
									style: Object.assign({}, S.mini, polishBusy ? IS.primaryOff : null),
									onClick: doPolishTheme
								}, polishBusy ? '润色中…' : '✨ 帮我润色主题'),
								h('span', { style: IS.meta },
									'把「需求说明」改写成「画面描述」。**改完先给你看，确认了才用**'))
							: null,
						// 电商：商品信息写法指引。**光有 placeholder 不够** —— 一输入文字它就消失了，
						// 而"该写什么"恰恰是打字时最需要的信息。所以做成可展开的常驻块 + 一键填入示例。
						outMode === 'ecommerce' && createMode !== 'comic'
							? h('div', { style: { marginTop: '9px' } },
								h('div', { style: IS.rowWrap },
									h('button', {
										type: 'button', style: S.mini,
										onClick: () => setEcGuide(!ecGuide)
									}, ecGuide ? '▾ 收起「商品信息怎么写」' : '▸ 商品信息怎么写？'),
									h('button', {
										type: 'button', style: S.mini,
										onClick: () => { setTheme(EC_INFO_EXAMPLE); setEcGuide(true) }
									}, '填入示例'),
									h('span', { style: IS.meta }, '填进去后可自由改，是普通文本')),
								ecGuide
									? h('div', {
										style: {
											marginTop: '8px', padding: '11px 12px', borderRadius: '10px',
											border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
											background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent)'
										}
									},
										h('div', { style: { fontSize: '12px', fontWeight: 650, marginBottom: '7px' } },
											'按这七项写，每项一行，越具体越好'),
										h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' } },
											h('tbody', null, EC_INFO_FIELDS.map((r) => h('tr', { key: r[0] },
												h('td', { style: { padding: '4px 8px 4px 0', verticalAlign: 'top', whiteSpace: 'nowrap', fontWeight: 600 } }, r[0]),
												h('td', { style: { padding: '4px 8px 4px 0', verticalAlign: 'top', color: 'var(--dsw-alias-label-secondary)' } }, '例：' + r[1]),
												h('td', { style: { padding: '4px 0', verticalAlign: 'top', color: 'var(--dsw-alias-label-secondary)' } }, '→ ' + r[2]))))),
										h('div', { style: Object.assign({}, IS.meta, { marginTop: '9px' }) },
											'「→」是这张信息会被哪些分镜读到：写全了，参数图才有尺寸、卖点图才有卖点。'),
										h('div', { style: { marginTop: '9px' } },
											h('button', {
												type: 'button', style: S.mini,
												onClick: () => copy(EC_INFO_EXAMPLE)
											}, '复制示例文本')))
									: null)
							: null,
						// 拍摄类型：只在「摄影」出图模式下出现。
						// 领域来自技能包的 couple-photo-orchestrator（情侣/婚纱/家庭/Cosplay 人像编排）。
						outMode === 'photography' && createMode !== 'comic'
							? h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '9px' }) },
								h('span', { style: IS.label }, '拍摄类型'),
								PHOTO_TYPES.map((t) => chipBtn(t, photoType === t,
									() => setPhotoType(photoType === t ? '' : t))),
								h('span', { style: IS.meta }, '可点选，也可自己写'))
							: null,
						outMode === 'photography' && createMode !== 'comic'
							? h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '7px' }) },
								h('input', {
									style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '300px' }),
									value: photoInput,
									placeholder: '或手动输入 / 修改拍摄类型，如「朋友旅行群像」',
									onChange: (e) => setPhotoInput(e.target.value),
									onKeyDown: (e) => {
										if (e.key === 'Enter') {
											e.preventDefault()
											const v = photoInput.trim()
											if (v) { setPhotoType(v); setPhotoInput('') }
										}
									}
								}),
								h('button', {
									type: 'button', style: S.mini,
									onClick: () => { const v = photoInput.trim(); if (v) { setPhotoType(v); setPhotoInput('') } }
								}, '+ 用它'),
								photoType ? h('span', { style: IS.meta }, '当前：' + photoType) : null)
							: null,
						outMode === 'photography' && createMode !== 'comic'
							? h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
								'⚠️ 这只是把「拍摄类型」当成场景约束写进提示词。技能包里真正做这件事的是 ' +
								'couple-photo-orchestrator —— 它是一套带确认关卡的多阶段编排（要 roster / 人数 / ' +
								'人物关系 / 套数 / 地点锚点），**不是一句提示词能替代的**。')
							: null,
						createMode === 'comic'
							? h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '9px' }) },
								h('span', { style: IS.label }, '分镜数'),
								h('div', { style: IS.seg },
									h('button', {
										type: 'button',
										style: Object.assign({}, IS.segBtn, panelCount === 0 ? IS.segOn : null),
										onClick: () => setPanelCount(0)
									}, '自动'),
									h('button', {
										type: 'button', style: IS.segBtn,
										onClick: () => setPanelCount(Math.max(1,
											(panelCount || (seriesPreview && seriesPreview.meta && seriesPreview.meta.produced) || 3) - 1))
									}, '−'),
									h('span', { style: { minWidth: '34px', textAlign: 'center', fontWeight: 650, fontSize: '12.5px' } },
										panelCount === 0 ? '自动' : String(panelCount)),
									h('button', {
										type: 'button', style: IS.segBtn,
										onClick: () => setPanelCount(Math.min(24,
											(panelCount || (seriesPreview && seriesPreview.meta && seriesPreview.meta.produced) || 0) + 1))
									}, '+')),
								h('button', { type: 'button', style: S.mini,
									onClick: () => doSplitPreview(false) }, '预览拆解'),
								// 智能分镜：让文本模型理解内容后重新组织每一格的画面。
								// 与「预览拆解」的区别不是快慢，是**能力** —— 确定性拆解只在
								// 已有句子边界上切，请求 5 格而只有 4 句时它凑不出来（meta.short）。
								h('button', {
									type: 'button',
									style: Object.assign({}, S.mini, splitBusy ? { opacity: 0.55 } : null),
									disabled: splitBusy,
									onClick: () => doSplitPreview(true)
								}, splitBusy ? '正在分析…' : '✨ AI 智能分镜'),
								seriesPreview && seriesPreview.meta
									? h('span', { style: IS.meta },
										'可拆 ' + seriesPreview.meta.produced + ' 镜（来源：' +
										(seriesPreview.meta.source === 'ai' ? 'AI 语义分镜'
											: seriesPreview.meta.source === 'paragraph' ? '空行段落'
											: seriesPreview.meta.source === 'sentence' ? '句子' : '—') + '）')
									: null)
							: null,
						batchMode && seriesPreview && seriesPreview.panels
							? h('div', { style: Object.assign({}, IS.meta, { marginTop: '8px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', paddingTop: '7px' }) },
								seriesPreview.panels.map((t, i) => h('div', { key: 'p' + i, style: { padding: '2px 0' } },
									h('div', null, '第 ' + (i + 1) + ' 镜：' + t.slice(0, 64) + (t.length > 64 ? '…' : '')),
									// 对白单独一行显示：它是**剧情信息**，不是画面描述的一部分。
									// 原文有对白却被拆丢，人物关系就会被画错（实测：熟人被画成陌生人）。
									(smartDialogues[i] || seriesPreview.dialogues && seriesPreview.dialogues[i])
										? h('div', { style: { paddingLeft: '10px', opacity: 0.85 } },
											'　台词：' + (smartDialogues[i] || seriesPreview.dialogues[i]))
										: null,
									(smartNotes[i] || seriesPreview.notes && seriesPreview.notes[i])
										? h('div', { style: { paddingLeft: '10px', opacity: 0.7, color: '#b76e00' } },
											'　后期：' + (smartNotes[i] || seriesPreview.notes[i]))
										: null)))
							: null,
						// 人物设定：智能分镜提炼出的全片固定外形。显示出来是因为它会
						// 影响每一格的画面 —— 用户看不到就会以为模型自己乱编的。
						batchMode && smartCast.length
							? h('div', { style: Object.assign({}, IS.meta, { marginTop: '8px' }) },
								castInjected.length
									? h('div', null, '人物形象（全片固定，每格共用）：')
									: null,
								castInjected.map((c, i) => h('div', { key: 'c' + i, style: { paddingLeft: '10px' } },
									'　' + c.name + '：' + c.desc)),
								// 让位说明：用户选了角色垫图时会看到这条，知道文字描述没被下发。
								// 不显示的话，用户会以为垫图之外还叠了一份描述（或者反过来）。
								castCovered.length
									? h('div', { style: { marginTop: '3px', color: '#b76e00' } },
										'　已由角色垫图锚定，不再注入文字描述：' +
										castCovered.map((c) => c.name).join('、'))
									: null)
							: null,
						// 确定性路线的语义与智能分镜不同，得说清楚：
						// 它**逐字保留原文**（对白本来就在文字里，不需要客户端再合并一次），
						// 台词只是提取出来给你看；后期备注它不解析（归属需要理解内容）。
						batchMode && seriesPreview && seriesPreview.meta
							&& seriesPreview.meta.splitter === 'deterministic'
							? h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
								'确定性拆解逐字保留原文：对白已在画面文字里，上面只是提取出来给你看；'
								+ '拍摄建议这类后期要求它不解析（要解析请用「AI 智能分镜」）。')
							: null,
						// 画内对白开关：关掉则只出画面，对白仍记录在案（留给后期字幕）。
						// 默认开 —— 漫画的对白本来就在格子里。
						batchMode && smartPanels.length
							? h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '8px' }) },
								h('span', { style: IS.label }, '画内对白'),
								chipBtn('画进格子', withDialogue, () => setWithDialogue(!withDialogue)),
								h('span', { style: IS.meta },
									withDialogue
										? '对白会写进这一格的提示词，由模型画进画面'
										: '画面里不出现文字，对白只留在分镜记录里（后期加字幕用）'))
							: null,
						batchMode && seriesPreview && seriesPreview.meta && seriesPreview.meta.short
							? h('p', { style: Object.assign({}, IS.meta, { color: '#b76e00', marginTop: '7px' }) },
								'这段文字只能确定性地拆出 ' + seriesPreview.meta.produced + ' 镜。要拆成 ' +
								seriesPreview.meta.requested + ' 镜，得把内容**展开成多个场景** —— 那是语义创作，' +
								'拆解器不硬凑（硬凑只能产出几张几乎一样的图）。这一步该由 Agent 做。')
							: null
					]),

					sec('3', '画幅比例与情绪',
						h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
							moods.length ? '已选 ' + moods.length + ' 个情绪' : '情绪可多选'), [
						h('div', { style: Object.assign({}, IS.rowWrap, { marginBottom: '8px' }) },
							RATIO_PRESETS.map((r) => chipBtn(r.label + ' ' + r.v, ratio === r.v,
								() => setRatio(ratio === r.v ? '' : r.v)))),
						h('div', { style: IS.rowWrap },
							h('input', {
								style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '238px' }),
								value: ratio,
								placeholder: '自定义画幅：16:9 / 3:2 / 1024x1024',
								onChange: (e) => setRatio(e.target.value)
							}),
							ratio ? h('button', { type: 'button', style: S.mini, onClick: () => setRatio('') }, '✕ 清除') : null,
							ratio ? h('span', { style: IS.meta }, ratioSizeHint(ratio)) : null),
						h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '8px' }) },
							MOODS.map((m) => chipBtn(m, moods.includes(m), () => toggleMood(m))),
							// 自定义情绪：技能允许「用户明确指定」，只是禁止 AI 生造非标复合长句
							customMoods.map((m) => h('button', {
								key: 'c' + m, type: 'button',
								style: Object.assign({}, IS.chip, IS.chipOn),
								onClick: () => toggleMood(m), title: '自定义情绪 · 点击移除'
							}, m + ' ✕'))),
						h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '8px' }) },
							h('input', {
								style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '238px' }),
								value: moodInput,
								placeholder: '自定义情绪：如「压抑」「宿命感」',
								onChange: (e) => setMoodInput(e.target.value),
								onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addMood() } }
							}),
							h('button', { type: 'button', style: S.mini, onClick: addMood }, '+ 添加'),
							h('span', { style: IS.meta },
								fusionOn
									? '技能规定默认从 15 个预设里选；自定义词是你明确指定的，按技能允许 —— 但别写成生造的复合长句'
									: '技能无此参数，走「附加约束」通道'))
					]),

					sec('4', '视觉资产与风格搭配',
						h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'center' } },
							h('label', {
								style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer', fontWeight: fusionOn ? 650 : 400 }
							},
								h('input', {
									type: 'checkbox', checked: fusionOn,
									onChange: (e) => setFusionOn(e.target.checked)
								}), '风格融合'),
							h('button', { type: 'button', style: S.mini, onClick: randomPick }, '🎲 智能随机抽卡'),
							h('button', { type: 'button', style: S.mini, onClick: clearAll }, '✦ 一键清空')), [
						fusionOn
							? h('p', { style: Object.assign({}, IS.meta, { marginBottom: '9px' }) },
								'风格融合：给「角色」和「场景」各指定一套视觉语言（编号或名称），' +
								'让两者在同一画面里**独立共存** —— 缩微摄影尺度反差、物理光影统一、不许磨成平庸的混合风。' +
								'场景风格也可以直接写名称，如「写实」。')
							: null,
						h('div', { style: Object.assign({}, IS.rowWrap, { marginBottom: '8px' }) },
							h('span', { style: IS.label }, '自建图库垫图'),
							h('span', { style: IS.meta }, '可选 · 出图时保持主体视觉一致'),
							h('button', { type: 'button', style: S.mini, onClick: () => openPicker('assets') }, '+ 添加自建资产')),
						// 图库目录没挂载时，挂载面板就放在这里 ——
						// 它本来就属于「自建图库」，不该只在别处的一个提示里被提及
						!libReady ? mountPanel() : null,
						// 电商图：商品图上传放在最前面 —— 在这个模式下它是主体，不是可选项
						outMode === 'ecommerce'
							? h('div', {
								style: {
									border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: '10px',
									padding: '11px 12px', marginBottom: '9px',
									background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent)'
								}
							},
								h('div', { style: { fontSize: '12.5px', fontWeight: 650, marginBottom: '5px' } },
									Req(), '① 上传商品图'),
								h('p', { style: Object.assign({}, IS.meta, { marginBottom: '8px' }) },
									'上传你要卖的那张商品照片，它会作为**主体参考**参与出图（让模型照着这个商品画，' +
									'而不是凭空编一个）。**只用于本次生成**：文件落在工作区临时目录，不进资产库、' +
									'不进挑选器。要长期复用请用下面的「存入资产库」归到道具库。'),
								h('div', { style: IS.rowWrap },
									h('label', {
										style: Object.assign({}, IS.primary, IS.segBtn,
											{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' })
									},
										h('input', {
											type: 'file', accept: 'image/*', multiple: true,
											style: { display: 'none' }, onChange: onPickFiles
										}), uploadBusy ? '上传中…' : '📎 选择商品图'),
									uploads.map((u) => h('span', {
										key: u.relPath,
										style: Object.assign({}, IS.chip, IS.chipOn, { cursor: 'default' })
									},
										u.name + ' · ' + Math.round((u.bytes || 0) / 1024) + 'KB',
										h('button', {
											type: 'button',
											style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 0 0 6px' },
											onClick: () => setUploads((cur) => cur.filter((x) => x.relPath !== u.relPath))
										}, '✕'))),
									uploads.length ? null : h('span', { style: IS.meta }, '还没选（最多 6 张）')))
							: null,
						assetRefs.length === 0
							? h('div', {
								style: { border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '14px', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', marginBottom: '8px' }
							}, '点击添加自建资产（角色 CH / 道具 PR / 场景 SCN，可多选）')
							: h('div', { style: Object.assign({}, IS.rowWrap, { marginBottom: '8px' }) },
								assetRefs.map((r) => h('button', {
									key: r.id, type: 'button', style: Object.assign({}, IS.chip, IS.chipOn),
									onClick: () => useAsset(r), title: '点击移除'
								}, r.id + ' ' + (r.name || '') + ' ✕')),
								h('button', { type: 'button', style: S.mini, onClick: () => setAssetRefs([]) }, '清空垫图')),
						// 四张排一行（融合未开时是三张，用三列填满，不留空槽）
						h('div', {
							style: Object.assign({}, IS.pickGrid, {
								gridTemplateColumns: fusionOn
									? 'repeat(4, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))'
							})
						},
							pickCard('图型', sel.layout, 'layout', '可选 161'),
							pickCard(fusionOn ? '角色风格' : '风格', sel.style, 'style', '可选 324', true),
							fusionOn ? h('button', {
								type: 'button', style: IS.pickCard, onClick: () => openPicker('scene')
							},
								sceneStyle && isStyleId(sceneStyle)
									? h('div', { style: Object.assign({}, IS.pickThumb, { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px' }) }, sceneStyle)
									: h('div', { style: Object.assign({}, IS.pickThumb, { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }) }, '可选（风格/写实）'),
								h('div', { style: IS.label }, Req(), '场景风格' + (sceneStyle ? '' : '（未选）')),
								sceneStyle
									? h('div', { style: IS.name }, sceneStyleLabel().title)
									: h('div', { style: IS.meta }, '点击选择'))
								: null,
							pickCard('主题色', sel.color, 'color', '可选 36'))
					]),

					// 融合模式不垫编号参考图：契约是靠文字把两套风格各自完整展开，
					// 而且两张风格图谁对应角色、谁对应场景在接口层没法表达
					fusionOn ? h('p', { style: Object.assign({}, IS.meta, { margin: 0 }) },
						'风格融合不走「编号参考图」：技能要求把两套风格的特征**逐字完整写进提示词**，' +
						'而不是靠垫图（垫图还会把样图里的主体一起带进来）。自建资产垫图仍然可用。')
						: h('div', null,
							h('div', { style: IS.rowWrap },
								h('span', { style: IS.label }, '编号参考图'),
								seg([{ v: 'on', label: '垫入参考图' }, { v: 'off', label: '只给文字' }],
									withRef ? 'on' : 'off',
									(v) => { const b = v === 'on'; setWithRef(b); setArms(b ? 'ref' : 'text') }),
								h('span', { style: IS.meta }, sel.style ? '该风格的样图' : '先选一个风格')),
							h('p', { style: Object.assign({}, IS.meta, { margin: '5px 0 0' }) },
								dec.activation_source
									? decisionText(dec)
									: (sel.style ? '正在查能力判定…' : '选中风格后，这里会显示技能对该风格的建议（要不要特征词、要不要垫图）')),
							h('p', { style: Object.assign({}, IS.meta, { margin: '3px 0 0' }) },
								'垫参考图能让模型认准画风，但可能把样图里的主体一起带进画面 —— 预研实测过；反之纯文字对「极简 / 涂鸦」这类画法容易退化成精细插画。')),

					h('div', { style: IS.stickBar },
						// 缺风格时**真的不给发请求**，并直接把引导说在按钮上 ——
						// 原来是"只把颜色调灰、点了照样发"，用户拿到的是后端那句冷冰冰的
						// styleId required，而不是这里写好的提示。看着禁用、行为不禁用，最费解。
						!styleReady && !busy
							? h('button', {
								type: 'button',
								style: Object.assign({}, IS.primary, IS.primaryOff,
									{ flex: '1 1 auto', cursor: 'not-allowed' }),
								onClick: () => { flash('还差一步：选一个风格编号'); goTab('风格库') }
							}, '⚡ 先选风格，再开始创作')
							: h('button', {
								type: 'button',
								style: Object.assign({}, IS.primary,
									(busy ||
										(fusionOn && !sceneStyle.trim()) ||
										(!batchMode && outMode === 'ecommerce' && !uploads.length && !assetRefs.length) ||
										(batchMode ? !(createMode === 'comic' ? sourceText : theme).trim()
											: !theme.trim()))
										? IS.primaryOff : null,
									{ flex: '1 1 auto' }),
								onClick: doGenerate
							}, busy ? '提交中…'
								: createMode === 'stepwise' ? '⚡ 生成提示词'
									: createMode === 'comic' ? '🎬 生成整组漫画'
										: (outMode === 'ecommerce' && ecMulti)
											? '🛒 生成 ' + ecCount + ' 张详情页图'
											: '⚡ 开始创作'),
						h('button', { type: 'button', style: S.btn, onClick: () => doPreview() }, '预览提示词'))
				),

				h('div', { style: IS.previewCol },
					h('div', { style: Object.assign({}, IS.rowWrap, { marginBottom: '12px' }) },
						h('span', { style: { fontWeight: 650 } }, batchMode ? '分镜板' : '渲染预览'),
						h('span', { style: Object.assign({}, S.tag, { marginLeft: 'auto' }) },
							batchMode
								? (comicPanels.length + ' 张 · 已完成 ' + comicDone)
								: (effMode === 'graphic-text' ? '图文模式' : '纯图模式'))),
					// 漫画流 / 电商详情页多图：右栏是分镜板（每格一张，完成即出图），而不是单张最新图
					batchMode ? comicBoard : (
					latest
						? h('div', { style: IS.previewBox },
							h('img', {
								style: { width: '100%', borderRadius: '10px', display: 'block', cursor: 'zoom-in' },
								src: '/api/workbench/image-asset?p=' + encodeURIComponent(latest.rel_path) + '&from=workspace',
								alt: 'latest-output',
								onClick: () => openLightbox(
									'/api/workbench/image-asset?p=' + encodeURIComponent(latest.rel_path) + '&from=workspace',
									'#' + latest.job_id + ' · ' + (latest.style_id || ''),
									(latest.width ? latest.width + '×' + latest.height + ' · ' : '') +
									(latest.created_at || '') + ' · 点击看大图')
							}),
							h('div', { style: Object.assign({}, IS.rowWrap, { marginTop: '10px' }) },
								h('span', { style: IS.meta },
									'#' + latest.job_id + ' · ' + (latest.style_id || '—') +
									(latest.width ? ' · ' + latest.width + '×' + latest.height : '')),
								h('a', {
									style: S.mini,
									href: '/api/workbench/image-asset?p=' + encodeURIComponent(latest.rel_path) + '&from=workspace',
									download: 'job' + latest.job_id + '-' + latest.arm + '.png',
									target: '_blank', rel: 'noreferrer'
								}, '下载'),
								h('button', {
									type: 'button', style: S.mini,
									onClick: () => { setSaveTarget(latest); setSaveName(''); setSaveCat('characters') }
								}, '存入资产库')))
						: previewJob
							// 已提交、还没出图：显示进度，别继续显示"准备开始生成"
							? h('div', {
								style: Object.assign({}, IS.previewBox, {
									textAlign: 'center', padding: '52px 20px',
									border: '1px dashed var(--dsw-alias-border-l1)'
								})
							},
								previewJob.status === 'failed'
									? h('div', null,
										h('div', { style: { fontSize: '26px', marginBottom: '8px' } }, '⚠️'),
										h('div', { style: { fontWeight: 650, marginBottom: '6px', color: '#b42318' } }, '生成失败'),
										h('div', { style: Object.assign({}, IS.meta, { wordBreak: 'break-word' }) },
											String(previewJob.error || '未知原因').slice(0, 220)))
									: h('div', null,
										h('div', { style: { fontSize: '30px', marginBottom: '10px' } },
											previewJob.status === 'queued' ? '⏳' : '🎨'),
										h('div', { style: { fontWeight: 650, marginBottom: '6px', color: '#b76e00' } },
											(previewJob.status === 'queued' ? '排队中' : '生成中')
											+ '… ' + previewElapsed + 's'),
										h('div', { style: IS.meta },
											'任务 #' + previewJob.id + ' · 一般 30–70 秒'),
										h('div', { style: Object.assign({}, IS.meta, { marginTop: '8px', maxWidth: '380px', marginLeft: 'auto', marginRight: 'auto', textAlign: 'left', opacity: 0.75 }) },
											'主题：' + String(previewJob.theme || '').slice(0, 60) + (String(previewJob.theme || '').length > 60 ? '…' : '')),
										// 提交后迟迟不转 running → 后台进程多半没起来，给一条能自救的路
										(previewJob.status === 'queued' && previewElapsed > 25)
											? h('div', { style: { marginTop: '12px' } },
												h('div', { style: { fontSize: '12px', color: '#b42318', marginBottom: '6px' } },
													'一直停在「排队中」说明后台生成进程没起来'),
												h('button', {
													type: 'button', style: S.btn,
													onClick: async () => {
														try {
															const r = await apiPost('/api/workbench/image-run', { jobId: previewJob.id })
															if (!r.ok) throw new Error(r.error || '启动失败')
															flash('已重新拉起生成进程')
															await reload()
														} catch (e) { flash(String((e && e.message) || e)) }
													}
												}, '重试启动'))
											: null))
							: h('div', { style: Object.assign({}, IS.previewBox, { textAlign: 'center', padding: '46px 20px' }) },
								h('div', { style: { fontSize: '30px', marginBottom: '10px' } }, '🖼'),
								h('div', { style: { fontWeight: 650, marginBottom: '6px' } }, '准备开始生成'),
								h('div', { style: IS.meta },
									'左侧选好风格与主题，点底部按钮即可；也可以先「预览提示词」看看最终会发出去什么。'),
								h('div', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
									'这里只显示**本次**创作的结果。想回看历史作品，去「我的创作」。'))),
					h('div', { style: IS.previewBox },
						h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' } },
							'生成队列' + (pending ? '（进行中 ' + pending + '）' : '')),
						jobs.length === 0
							? h('div', { style: S.empty }, '还没有生成任务')
							: jobs.slice(0, 12).map((j) => h('div', { key: j.id, style: IS.jrow },
								h('span', { style: IS.idBadge }, '#' + j.id),
								h('span', {
									style: Object.assign({}, IS.status, { color: IS_STATUS_COLOR[j.status] || 'inherit' })
								}, IS_STATUS_ZH[j.status] || j.status),
								h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
									(j.style_id || '—') + ' · ' + (j.theme || '')),
								h('span', { style: IS.meta }, j.n_images ? j.n_images + ' 张' : ''),
								h('button', { type: 'button', style: S.mini, onClick: () => rerun(j) }, '重跑'),
								j.error ? h('span', { style: { color: '#b42318', fontSize: '11px' } }, String(j.error).slice(0, 60)) : null)))
				)
			)

			// ── 资产库 ──
			// 漫画流是**一次创作 = 一个数据对象**：一组的 N 张归成一张卡（带张数角标），
			// 点开在同一个界面里看全部分镜。按分镜拆成 N 个独立资产会把一次创作打散，
			// 时间线、系列标题、镜序全丢了。
			// ⚠️ 角色 / 道具 / 场景的**基准图生成**（noStyle 任务）不进「我的创作」——
			// 它们已经归档在「角色资产库」里，再列一遍就是重复。
			// **在数据入口处过滤**，而不是在渲染时滤：否则统计、筛选数量会与卡片对不上
			// （「全部 9」但只看得到 7 张，用户会开始怀疑整个面板）。
			const creativeAssets = assets.filter((a) => {
				let p = {}
				try { p = JSON.parse((a && a.job_params) || '{}') } catch (e) { p = {} }
				return !p.noStyle
			})
			const seriesGroups = (function () {
				const g = {}
				creativeAssets.forEach((a) => {
					if (a.series_id) (g[a.series_id] = g[a.series_id] || []).push(a)
				})
				const meta = {}
				;(seriesList || []).forEach((s) => { meta[s.id] = s })
				return Object.keys(g).map((k) => ({
					id: Number(k),
					items: g[k].slice().sort((x, y) => (x.panel_index || 0) - (y.panel_index || 0)),
					meta: meta[k] || null
				})).sort((a, b) => b.id - a.id)
			})()
			const looseAssets = creativeAssets.filter((a) => !a.series_id)
			// 出图模式筛选。**早期任务里没存 outMode**（那时只存了技能模式与构图要求），
			// 所以：新任务直接读；老任务按能确定的线索回推；推不出的归到「早期任务」——
			// 不硬猜成某个具体模式，否则筛选结果就是在撒谎。
			const MODE_LABEL = {
				'pure-image': '纯图', 'graphic-text': '图文', poster: '海报',
				'article-illustration': '文章插图', 'article-cover': '文章封面',
				photography: '摄影', ecommerce: '电商图', fusion: '风格融合', unknown: '早期任务'
			}
			const assetOutMode = (a) => {
				let p = {}
				try { p = JSON.parse((a && a.job_params) || '{}') } catch (e) { p = {} }
				if (p.outMode) return p.outMode
				if (p.fusionOn) return 'fusion'
				const c = String(p.constraint || '')
				if (c.indexOf('海报构图') >= 0) return 'poster'
				if (c.indexOf('封面构图') >= 0) return 'article-cover'
				if (c.indexOf('写实摄影质感') >= 0) return 'photography'
				if (p.mode === 'graphic-text') return 'graphic-text'
				if (p.mode === 'pure-image') return 'pure-image'
				return 'unknown'
			}
			const modeOfGroup = (g) => (g.items[0] ? assetOutMode(g.items[0]) : 'unknown')
			// 查看 tab：**按出图模式分类** —— 不再混入「漫画流 / 单图」这类形态维度。
			// 形态是"一次出了几张"，模式是"这是哪种图"，两个维度混在一排里会互相干扰。
			const inAssetFilter = (mode) => !assetFilter || mode === assetFilter
			const shownGroups = seriesGroups.filter((g) => inAssetFilter(modeOfGroup(g)))
			const shownLoose = looseAssets.filter((a) => inAssetFilter(assetOutMode(a)))
			// 「我的创作」是**一条时间线**，系列卡与单图卡必须混排。
			// 原写法是 `shownGroups.map(...).concat(shownLoose.map(...))` —— 两段拼接，
			// 于是刚出的单图会被排到很久以前的漫画流下面，看着像没排序。
			// 系列的取时用**组内最后一张**：那才是这组创作完成的时间（首张是开始时间）。
			const cardTimeOfGroup = (g) => {
				let t = ''
				g.items.forEach((a) => { const v = String(a.created_at || ''); if (v > t) t = v })
				return t
			}
			// created_at 是 'YYYY-MM-DD HH:MM:SS'，字符串比较即时间比较（零填充，可直接比）
			const assetCards = shownGroups
				.map((g) => ({ t: cardTimeOfGroup(g), group: g, asset: null }))
				.concat(shownLoose.map((a) => ({ t: String(a.created_at || ''), group: null, asset: a })))
				.sort((x, y) => (x.t < y.t ? 1 : (x.t > y.t ? -1 : 0)))
			// 哪些是「没存 outMode、靠回推」的 —— 单独数出来，界面上要说清楚
			const inferredCount = creativeAssets.filter((a) => {
				let p = {}
				try { p = JSON.parse((a && a.job_params) || '{}') } catch (e) { p = {} }
				return !p.outMode
			}).length
			// 统计口径（两个粒度不能混）：
			//   · 资产总数 / 电商图 / 漫画图 / 其他 —— 按**卡**算。因为「一次创作 = 一个数据对象」：
			//     一个漫画流 6 张是 **1 个资产**，不是 6 个。
			//   · 任务数 / 今日生成数量 —— 按**张**（任务）算，这才是它们该有的粒度。
			const assetStat = (function () {
				const cards = seriesGroups.length + looseAssets.length
				let ec = 0, comic = 0
				seriesGroups.forEach((g) => { if (modeOfGroup(g) === 'ecommerce') ec += 1; else comic += 1 })
				looseAssets.forEach((a) => { if (assetOutMode(a) === 'ecommerce') ec += 1 })
				const d = new Date()
				const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
					+ '-' + String(d.getDate()).padStart(2, '0')
				return {
					cards, ec, comic, other: Math.max(0, cards - ec - comic),
					today: creativeAssets.filter((a) => String(a.created_at || '').slice(0, 10) === key).length
				}
			})()
			// 查看 tab = **与出图模式控件同一套顺序与命名**（纯图 / 图文 / 海报 / 文章插图 /
			// 文章封面 / 摄影 / 电商图）。两处口径必须一致，否则会出现
			// 「出图模式里叫电商图、资产库筛选里叫 ecommerce」这种同名不同写法的分裂。
			// 数量为 0 的模式**照样显示**（灰掉）：它告诉用户"这个模式存在，你还没有"，
			// 比让 tab 列表随数据忽长忽短更好理解。
			const STUDIO_MODES = ['pure-image', 'graphic-text', 'poster',
				'article-illustration', 'article-cover', 'photography', 'ecommerce']
			const filterChips = (function () {
				const counts = {}
				seriesGroups.forEach((g) => { const k = modeOfGroup(g); counts[k] = (counts[k] || 0) + 1 })
				looseAssets.forEach((a) => { const k = assetOutMode(a); counts[k] = (counts[k] || 0) + 1 })
				const chips = [{ v: '', label: '全部', n: seriesGroups.length + looseAssets.length }]
				STUDIO_MODES.forEach((k) => {
					chips.push({ v: k, label: MODE_LABEL[k] || k, n: counts[k] || 0 })
				})
				// 风格融合是**开关**（不是出图模式），有数据时才追加。
				// 「早期任务 / 未标注」不再单独给 tab —— 那是个数据质量问题，不是一种图；
				// 单独给它一个筛选按钮，等于把一个历史遗留问题当成产品分类展示。
				if (counts.fusion > 0) chips.push({ v: 'fusion', label: MODE_LABEL.fusion, n: counts.fusion })
				return chips
			})()
			const assetThumb = (a, label, sub) => h('div', { key: 'a' + a.id, style: IS.card },
				h('img', {
					style: Object.assign({}, IS.thumb, { cursor: 'zoom-in' }),
					src: '/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
					loading: 'lazy', alt: 'asset-' + a.id,
					onClick: () => openLightbox(
						'/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
						label, sub || '点击看大图')
				}),
				h('div', { style: IS.name }, label),
				h('div', { style: IS.meta }, sub),
				h('div', { style: IS.row },
					h('a', {
						style: S.mini, href: '/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
						download: 'job' + a.job_id + '-' + a.arm + '.png', target: '_blank', rel: 'noreferrer'
					}, '下载'),
					h('button', {
						type: 'button', style: S.mini,
						onClick: () => { setSaveTarget(a); setSaveName(''); setSaveCat('characters') }
					}, '存入资产库'),
					h('button', {
						type: 'button', style: Object.assign({}, S.mini, { color: '#b42318' }),
						onClick: () => doDeleteAsset(a)
					}, '删除')))
			// 删除：**必须让用户确认，而且要说清删的是什么、几张**。
			// 一个裸的「确定要删除吗」，用户不知道自己删的是 1 张还是一组 6 张，也无法判断后果。
			const doDeleteAsset = async (a) => {
				if (!window.confirm('删除这张生成物？\n\n' + (a.style_id || '—') + '\n' +
					String(a.theme || '').slice(0, 60) +
					'\n\n磁盘上的图片文件会一并删除，不可恢复。')) return
				try {
					const r = await apiPost('/api/workbench/image-jobs',
						{ action: 'delete-asset', assetId: a.id })
					if (!r.ok) throw new Error(r.error || '删除失败')
					flash('已删除（含 ' + (r.filesRemoved || 0) + ' 个文件）')
					await reload()
					await reloadSeries()
				} catch (e) { flash(String((e && e.message) || e)) }
			}
			const doDeleteSeries = async (g) => {
				if (!window.confirm('删除整组？\n\n#' + g.id + '　共 ' + g.items.length + ' 张\n' +
					'\n整组的分镜与图片文件都会删除，不可恢复。')) return
				try {
					const r = await apiPost('/api/workbench/image-jobs',
						{ action: 'delete-series', seriesId: g.id })
					if (!r.ok) throw new Error(r.error || '删除失败')
					flash('已删除整组（' + (r.jobCount || 0) + ' 个任务 / ' + (r.filesRemoved || 0) + ' 个文件）')
					await reload()
					await reloadSeries()
				} catch (e) { flash(String((e && e.message) || e)) }
			}
			const assetView = h('div', { style: IS.flexCol },
				h('div', { style: S.head },
					h('h1', { style: S.h1 }, '我的创作'),
					h('p', { style: S.sub },
						'这里放**创作产出**：漫画流、电商详情页、单张出图。' +
						'角色 / 道具 / 场景的基准图不在其中 —— 它们已归在「角色资产库」，再列一遍是重复。')
				),
				h('div', { style: S.body },
					h('div', { style: IS.row },
						h('div', { style: IS.stat }, h('div', { style: IS.statN }, String(assetStat.cards)), h('div', { style: IS.statL }, '资产总数')),
						h('div', { style: IS.stat }, h('div', { style: IS.statN }, String(jobs.length)), h('div', { style: IS.statL }, '任务数')),
						h('div', { style: IS.stat }, h('div', { style: IS.statN }, String(assetStat.ec)), h('div', { style: IS.statL }, '电商图')),
						h('div', { style: IS.stat }, h('div', { style: IS.statN }, String(assetStat.comic)), h('div', { style: IS.statL }, '漫画图')),
						h('div', { style: IS.stat }, h('div', { style: IS.statN }, String(assetStat.other)), h('div', { style: IS.statL }, '其他')),
						h('div', { style: IS.stat }, h('div', { style: IS.statN }, String(assetStat.today)), h('div', { style: IS.statL }, '今日生成数量'))),
					h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
						'资产按**卡**计（一次创作 = 一个数据对象：一个漫画流 6 张算 1 个资产）；'
						+ '任务数与今日生成数量按**张**计。累计计费 ' +
						(usage ? usage.totalCalls : '—') + ' 张（本地账本，接口没有配额端点）。'),
					h('div', { style: IS.subTabs },
						h('span', { style: Object.assign({}, IS.meta, { alignSelf: 'center', marginRight: '2px' }) }, '查看：'),
						filterChips.map((f) => h('button', {
							key: 'f' + f.v, type: 'button',
							style: Object.assign({}, IS.pill, assetFilter === f.v ? IS.pillOn : null,
								(f.n === 0 && f.v !== '') ? { opacity: 0.42 } : null),
							onClick: () => setAssetFilter(f.v)
						}, f.label + ' ' + f.n))),
					inferredCount > 0
						? h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
							'出图模式从 2026-10-08 起随任务记录。更早的 ' + inferredCount +
							' 张是按「技能模式 + 构图要求」回推的：海报 / 文章封面 / 摄影 / 风格融合都能准确定位，' +
							'但**「纯图」与「文章插图」在旧数据里无法区分**（两者的技能模式与约束完全相同），' +
							'统一按「纯图」计。')
						: null,
					creativeAssets.length === 0
						? h('div', { style: S.empty }, '还没有生成物')
						: (shownGroups.length + shownLoose.length) === 0
							? h('div', { style: S.empty }, '这个筛选下没有生成物')
							: h('div', { style: IS.grid },
								assetCards.map((c) => (c.group
									? h('div', {
										key: 's' + c.group.id, style: IS.card,
										onClick: () => setPanelView(c.group)
									},
										h('div', { style: { position: 'relative', cursor: 'zoom-in' } },
											h('img', {
												style: IS.thumb, loading: 'lazy', alt: 'series-' + c.group.id,
												src: '/api/workbench/image-asset?p=' + encodeURIComponent(c.group.items[0].rel_path) + '&from=workspace'
											}),
											h('span', { style: IS.badgeOn }, '漫画流 ' + c.group.items.length + ' 张')),
										h('div', { style: IS.name },
											'漫画流 #' + c.group.id + (c.group.meta && c.group.meta.title ? ' · ' + c.group.meta.title : '')),
										h('div', { style: IS.meta },
											(MODE_LABEL[modeOfGroup(c.group)] || '—') + ' · ' +
											(c.group.items[0].style_id || '—') + ' · 点击看全部分镜'),
										h('button', {
											type: 'button',
											style: Object.assign({}, S.mini, { marginTop: '6px', color: '#b42318' }),
											onClick: (e) => { e.stopPropagation(); doDeleteSeries(c.group) }
										}, '删除整组')
									)
									: assetThumb(c.asset,
										(c.asset.style_id || '—') + ' · ' + (c.asset.arm === 'ref' ? '垫图' : '纯文字'),
										(MODE_LABEL[assetOutMode(c.asset)] || '—') + ' · ' +
										(c.asset.width && c.asset.height ? c.asset.width + '×' + c.asset.height + ' · ' : '') +
										Math.round((c.asset.bytes || 0) / 1024) + ' KB'))))
				)
			)

			// 提示词预览弹窗里的一段：标题 + 复制 + 可滚动的原文。
			// 必须定义在 return 之前 —— return 的参数列表是**表达式位置**，里面不能声明 const。
			const promptBlock = (title, text, note) => (text ? h('div', { style: { marginBottom: '13px' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' } },
					h('span', { style: { fontSize: '12px', fontWeight: 650, color: 'var(--dsw-alias-label-secondary)' } }, title),
					h('button', { type: 'button', style: S.mini, onClick: () => copy(text) }, '复制')),
				h('pre', {
					style: {
						margin: 0, padding: '10px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: '1.65',
						whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '34vh', overflowY: 'auto',
						background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)',
						border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)'
					}
				}, text),
				note ? h('div', { style: Object.assign({}, IS.meta, { marginTop: '4px' }) }, note) : null) : null)

			const view = mod === '技能包' ? h(SkillPack, { pack: 'image' })
				: curGal ? galleryView(curGal)
					: mod === ASSET_MOD ? assetLibView
						: mod === '漫图创作' ? studioView
							: assetView

			return h('div', { style: S.page },
				h('div', { style: S.tabs },
					MODULES.map((m) => h('button', {
						key: m, type: 'button',
						style: Object.assign({}, S.tab, mod === m ? S.tabOn : S.tabOff),
						onClick: () => goTab(m)
					}, m)),
					h('span', { style: { marginLeft: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
						(sel.style ? '风格 ' + sel.style.id + ' · ' : '未选风格 · ') +
						(assetRefs.length ? '垫图 ' + assetRefs.length + ' 张 · ' : '') +
						'待生成 ' + pending + ' · 已出 ' + assets.length + ' 张')),
				view,
				err ? h('div', { style: S.err }, err) : null,
				drawer ? h(ImageDrawer, {
					item: drawer, catalog, layoutDoc, onClose: () => setDrawer(null),
					onPick: pick, onCopy: copy, imgUrl, onUseAsset: useAsset,
					onPreview: doPreview, hasStyle: styleReady, hasTheme: !!theme.trim(),
					onGenerate: () => goTab('漫图创作')
				}) : null,
				// 挑选抽屉：图型 / 风格 / 主题色 / 自建资产。
				// 分类与搜索与画廊**共用同一套判定**（groupOptions / filterItems），
				// 不另写一份 —— 否则「纯数字按编号精确搜」这条迟早两边不一致。
				// 自建资产的独立生成抽屉：填 → 生成 → 结果 → 存入本库，全程不离开本模块
			libGen ? h('div', { style: S.drawer },
				h('button', { type: 'button', style: S.close, onClick: () => setLibGen(null) }, '✕'),
				h('div', { style: S.drawerHead },
					h('div', { style: IS.idBadge }, '生成' + (ASSET_LABEL[libGen.catKey] || '资产')),
					h('h2', { style: { margin: '4px 0 0', fontSize: '15px' } },
						'出一张' + (ASSET_LABEL[libGen.catKey] || '资产') + '基准图'),
					h('p', { style: S.sub }, '三步走完：填 → 生成 → 存入本库。不跳去漫图创作。')),
				h('div', { style: S.drawerBody },
					!libReady ? mountPanel() : null,
					// ⚠️ 这里**不用 <label> 包 textarea**：全项目能正常输入的 textarea（漫图创作的主题框）
					// 都是裸的；label 包的都是 input。表单控件的包装方式保持与已验证可用的写法一致。
					h('div', { style: IS.field },
						h('span', { style: IS.label }, Req(), '提示词'),
						h('textarea', {
							style: Object.assign({}, S.textarea, { minHeight: '90px' }),
							value: libGen.prompt,
							placeholder: libGen.catKey === 'characters'
								? '例：一个穿黑西装的白猫侍者，戴单片眼镜，站姿端正，白底'
								: (libGen.catKey === 'props' ? '例：一只木质餐盘，浅色木纹，俯视，白底' : '例：清晨的江南水乡小巷，青石板路，薄雾'),
							onChange: (e) => libGenPatch({ prompt: e.target.value })
						})),
					h('div', { style: IS.rowWrap },
						h('span', { style: IS.label }, '参考图'),
						h('label', {
							style: Object.assign({}, IS.segBtn, { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' })
						},
							h('input', {
								type: 'file', accept: 'image/*', style: { display: 'none' },
								onChange: doLibGenUpload
							}), libGen.uploadBusy ? '上传中…' : (libGen.upName ? '换一张' : '📎 上传（可选）')),
						libGen.upName
							? h('span', { style: Object.assign({}, IS.chip, IS.chipOn, { cursor: 'default' }) },
								libGen.upName,
								h('button', {
									type: 'button',
									style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 0 0 6px' },
									onClick: () => libGenPatch({ upRel: '', upName: '' })
								}, '✕'))
							: h('span', { style: IS.meta }, '没有就留空；有实拍/草稿可以上传当垫图')),
					// 比例：按参考产品的形态 —— 只写比例本身，不带「封面 / 贴图」这类业务名
					h('div', { style: IS.rowWrap },
						h('span', { style: IS.label }, '比例'),
						LIB_RATIOS.map((v) => h('button', {
							key: 'r' + v, type: 'button',
							style: Object.assign({}, IS.segBtn, {
								display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
								gap: '4px', minWidth: '52px', padding: '7px 6px',
								borderColor: libGen.ratio === v ? 'var(--dsw-alias-label-primary)' : 'transparent'
							}),
							onClick: () => libGenPatch({ ratio: v })
						}, ratioShape(v, libGen.ratio === v),
							h('span', { style: { fontSize: '11.5px' } }, v || '智能'))),
						h('input', {
							style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '130px' }),
							value: libGen.ratio, placeholder: '自定义',
							onChange: (e) => libGenPatch({ ratio: e.target.value })
						})),
					h('div', { style: IS.rowWrap },
						h('span', { style: IS.label }, '风格'),
						h('span', { style: IS.meta },
							'**不需要选风格**：基准图是拿去做垫图参考的，画风由之后真正出图时决定。' +
							'这里会走「不依赖风格库」的最小拼装（图型原文 + 提示词），' +
							'不会再硬塞一个你没选过的画师风格。')),
					h('div', { style: IS.field },
						h('span', { style: IS.label }, Req(), '资产名称（存入时用）'),
						h('input', {
							style: S.search, value: libGen.name, placeholder: '例如：黑猫侍者',
							onChange: (e) => libGenPatch({ name: e.target.value })
						})),
					libGen.error ? h('div', { style: S.err }, libGen.error) : null,
					h('button', {
						type: 'button',
						style: Object.assign({}, IS.primary, (libGen.busy || !libReady) ? IS.primaryOff : null),
						onClick: doLibGen
					}, libGen.busy ? '提交中…' : (libGen.jobId ? '再生成一张' : '生成基准图')),
					// ── 进度与结果：都放在按钮下面，点了之后视线就在那里 ──
					libGen.jobId && !libGen.relPath && !libGen.error
						? h('div', {
							style: {
								marginTop: '10px', padding: '16px 12px', borderRadius: '10px', textAlign: 'center',
								border: '1px dashed var(--dsw-alias-border-l1)',
								background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)'
							}
						},
							// 走过的秒数让这个方块"在动"，否则它看起来和卡死没区别
							h('div', { style: { fontSize: '14px', fontWeight: 650, color: '#b76e00' } },
								'⏳ ' + (IS_STATUS_ZH[libGen.jobStatus] || '生成中') + '… ' + (libGen.startedAt
									? Math.max(0, Math.round((Date.now() - libGen.startedAt) / 1000)) + 's'
									: '')),
							h('div', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
								'任务 #' + libGen.jobId + ' · 状态 ' + (libGen.jobStatus || '—') + ' · 一般 30–60 秒'),
							// 排队超过 25 秒还没转成 running → 后台进程多半没起来，给一条能自救的路
							(libGen.jobStatus === 'queued' && libGen.startedAt
								&& (Date.now() - libGen.startedAt) > 25000)
								? h('div', { style: { marginTop: '8px' } },
									h('div', { style: { fontSize: '12px', color: '#b42318' } },
										'一直停在「排队中」说明后台生成进程没起来'),
									h('button', {
										type: 'button', style: Object.assign({}, S.mini, { marginTop: '6px' }),
										onClick: async () => {
											try {
												const r = await apiPost('/api/workbench/image-run', { jobId: libGen.jobId })
												if (!r.ok) throw new Error(r.error || '启动失败')
												flash('已重新拉起生成进程')
												await reload()
											} catch (e) { flash(String((e && e.message) || e)) }
										}
									}, '重试启动'))
								: null,
							h('div', { style: Object.assign({}, IS.meta, { marginTop: '2px' }) },
								'出图后会自动存入' + (ASSET_LABEL[libGen.catKey] || '资产库') + '，并在这里显示预览'))
						: null,
					libGen.relPath
						? h('div', { style: { marginTop: '10px' } },
							h('img', {
								style: Object.assign({}, IS.thumb, { aspectRatio: 'auto', width: '100%', cursor: 'zoom-in' }),
								src: '/api/workbench/image-asset?p=' + encodeURIComponent(libGen.relPath) + '&from=workspace',
								alt: 'lib-gen-result',
								onClick: () => openLightbox(
									'/api/workbench/image-asset?p=' + encodeURIComponent(libGen.relPath) + '&from=workspace',
									'生成结果', '点击看大图')
							}),
							libGen.saved
								? h('div', {
									style: {
										marginTop: '8px', padding: '8px 10px', borderRadius: '8px', textAlign: 'center',
										fontSize: '12.5px', background: 'color-mix(in srgb, #12b76a 14%, transparent)',
										border: '1px solid color-mix(in srgb, #12b76a 40%, transparent)'
									}
								}, '✓ 已自动存入' + (ASSET_LABEL[libGen.catKey] || '资产库') + '：' + libGen.saved)
								: h('button', {
									// 自动归档还在跑 / 或失败了，给一个手动兜底
									type: 'button',
									style: Object.assign({}, IS.primary, { marginTop: '8px' }),
									onClick: saveLibGen
								}, libGen.saveErr ? '自动归档失败，点这里重试' : '存入' + (ASSET_LABEL[libGen.catKey] || '资产库')),
							libGen.saveErr
								? h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px', color: '#b42318' }) },
									libGen.saveErr)
								: h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
									'存入后会转成 webp 写进图库目录、同步镜像并刷新索引，之后就能当垫图引用。'))
						: null)) : null,
			// 主题润色确认弹窗：**原文与改写并排**，让用户能直接比对再决定。
			// 不做"自动应用 + 撤销" —— 那等于默认改掉用户写的东西。
			polishResult ? h('div', { style: IS.overlay, onClick: () => setPolishResult(null) },
				h('div', {
					style: Object.assign({}, IS.overlayCard, { maxWidth: '680px' }),
					onClick: (e) => e.stopPropagation()
				},
					h('div', { style: { fontWeight: 650, fontSize: '15px', marginBottom: '4px' } }, '主题润色建议'),
					h('div', { style: Object.assign({}, IS.meta, { marginBottom: '12px' }) },
						'模型：' + (polishResult.model || '—') + ' · 确认后才会替换你当前的主题'),
					h('div', { style: { fontSize: '12px', fontWeight: 600, opacity: .7, marginBottom: '4px' } }, '你写的'),
					h('div', {
						style: {
							padding: '10px 12px', borderRadius: '8px', fontSize: '13px', lineHeight: '1.7',
							background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)',
							border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', wordBreak: 'break-word'
						}
					}, polishResult.original),
					h('div', { style: { fontSize: '12px', fontWeight: 600, opacity: .7, margin: '12px 0 4px' } }, '改写后（画面描述）'),
					h('div', {
						style: {
							padding: '10px 12px', borderRadius: '8px', fontSize: '13px', lineHeight: '1.7',
							background: 'color-mix(in srgb, #12b76a 12%, transparent)',
							border: '1px solid color-mix(in srgb, #12b76a 40%, transparent)', wordBreak: 'break-word'
						}
					}, polishResult.polished),
					h('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
						h('button', {
							type: 'button', style: Object.assign({}, IS.primary, { flex: '1 1 auto' }),
							onClick: () => {
								setTheme(polishResult.polished)
								setPolishResult(null)
								flash('已替换主题（原句没留，需要的话重新输入）')
							}
						}, '用这个'),
						h('button', {
							type: 'button',
							style: Object.assign({}, S.mini, { padding: '8px 18px' }),
							onClick: () => setPolishResult(null)
						}, '保持原样'))
				)) : null,
			// 提示词预览弹窗：长文本要能**读完**，所以用居中的大弹窗，而不是底部 toast
			promptModal ? h('div', { style: IS.overlay, onClick: () => setPromptModal(null) },
				h('div', {
					style: Object.assign({}, IS.overlayCard, { maxWidth: '900px', maxHeight: '90vh' }),
					onClick: (e) => e.stopPropagation()
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '13px', flexWrap: 'wrap' } },
						h('span', { style: { fontWeight: 650, fontSize: '15px' } }, '预览提示词'),
						promptModal.ok && promptModal.mode
							? h('span', { style: S.tag }, promptModal.mode === 'graphic-text' ? '图文' : '纯图') : null,
						promptModal.ok && promptModal.fusion ? h('span', { style: S.tag }, '风格融合') : null,
						promptModal.ok && promptModal.size
							? h('span', { style: Object.assign({}, S.tag, { borderColor: 'currentColor' }) },
								'接口尺寸 ' + promptModal.size) : null,
						h('button', {
							type: 'button', style: Object.assign({}, S.mini, { marginLeft: 'auto' }),
							onClick: () => setPromptModal(null)
						}, '✕ 关闭')),
					promptModal.ok
						? h('div', null,
							promptBlock('实发提示词（真正发给模型的这一版）',
								promptModal.sendZh || promptModal.promptZh,
								promptModal.refPath ? '已附上编号参考图：' + promptModal.refPath : null),
							promptModal.promptZh && promptModal.sendZh && promptModal.promptZh !== promptModal.sendZh
								? promptBlock('可复制版（给人用的，不含参考图约束）', promptModal.promptZh,
									'图文模式下技能规定：可复制版不放隔离块、实发版才放 —— 两版都给，免得以为漏了。')
								: null,
							promptBlock('英文版', promptModal.promptEn),
							promptModal.decision
								? h('div', { style: Object.assign({}, IS.meta, { marginTop: '2px' }) },
									'能力判定：' + (decisionText(promptModal.decision) ||
										promptModal.decision.activation_source || '—'))
								: null)
						: h('div', null,
							h('div', { style: { color: '#b42318', fontSize: '13.5px', fontWeight: 650, marginBottom: '7px' } }, '组词失败'),
							h('div', { style: { fontSize: '13px', lineHeight: '1.7', marginBottom: '10px' } }, promptModal.error),
							promptModal.usage
								? h('details', { style: { fontSize: '12px' } },
									h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)' } }, '展开参数用法（诊断用）'),
									h('pre', {
										style: {
											margin: '7px 0 0', padding: '9px 11px', borderRadius: '8px', fontSize: '11.5px',
											whiteSpace: 'pre-wrap', maxHeight: '26vh', overflowY: 'auto',
											background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)'
										}
									}, promptModal.usage))
								: null,
							h('p', { style: Object.assign({}, IS.meta, { marginTop: '10px' }) },
								'常见原因：必填没填（画面主题 / 风格 / 场景风格）、图型编号不存在、或该风格没有样图。')))
				) : null,
			// 分镜查看器：一次创作产出的全部图在**同一个界面**里看完（不拆成 N 个独立资产）
				panelView ? h('div', { style: IS.overlay, onClick: () => setPanelView(null) },
					h('div', { style: IS.overlayCard, onClick: (e) => e.stopPropagation() },
						h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } },
							h('span', { style: { fontWeight: 650, fontSize: '15px' } },
								'漫画分镜（' + panelView.items.length + ' 张）'),
							h('span', { style: S.tag }, '漫画流 #' + panelView.id),
							panelView.meta && panelView.meta.style_id
								? h('span', { style: Object.assign({}, S.tag, { borderColor: 'currentColor' }) }, panelView.meta.style_id)
								: null,
							h('button', {
								type: 'button', style: Object.assign({}, S.mini, { marginLeft: 'auto' }),
								onClick: () => setPanelView(null)
							}, '✕ 关闭')),
						panelView.items.map ? h('div', {
							style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(215px, 1fr))', gap: '13px' }
						}, panelView.items.map((a) => h('div', { key: a.id },
							h('div', { style: { position: 'relative' } },
								h('img', {
									style: Object.assign({}, IS.thumb, { cursor: 'zoom-in' }),
									src: '/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
									loading: 'lazy', alt: 'panel-' + a.panel_index,
									onClick: () => openLightbox(
										'/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
										'漫画流 #' + panelView.id + ' · 第 ' + (a.panel_index || '?') + ' 镜',
										(a.width ? a.width + '×' + a.height + ' · ' : '') + '点击看大图')
								}),
								h('span', { style: IS.badgeOn }, '第 ' + (a.panel_index || '?') + ' 镜')),
							h('div', { style: Object.assign({}, IS.row, { marginTop: '6px' }) },
								h('a', {
									style: S.mini, href: '/api/workbench/image-asset?p=' + encodeURIComponent(a.rel_path) + '&from=workspace',
									download: 'job' + a.job_id + '.png', target: '_blank', rel: 'noreferrer'
								}, '下载'),
								h('button', {
									type: 'button', style: S.mini,
									onClick: () => { setSaveTarget(a); setSaveName(''); setSaveCat('characters') }
								}, '存入资产库'))))) : null)) : null,
				assetDetail ? h('div', {
					style: {
						position: 'fixed', inset: 0, zIndex: 61, background: 'rgba(0,0,0,0.55)',
						display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px'
					},
					onClick: () => setAssetDetail(null)
				},
					h('div', {
						style: {
							background: 'var(--dsw-alias-bg-primary, #fff)',
							color: 'var(--dsw-alias-label-primary)',
							borderRadius: '12px', padding: '20px 22px',
							maxWidth: '580px', width: '100%', maxHeight: '82vh', overflowY: 'auto',
							boxShadow: '0 20px 60px rgba(0,0,0,0.35)'
						},
						// 点内容区不关，点遮罩才关 —— 否则想选中文字就关了
						onClick: (e) => e.stopPropagation()
					},
						h('div', { style: { fontSize: '16px', fontWeight: 700 } },
							assetDetail.name || assetDetail.id),
						h('div', { style: Object.assign({}, IS.meta, { marginTop: '3px' }) },
							assetDetail.id + (assetDetail.role ? ' · ' + assetDetail.role : '')),
						(assetDetail.tags || []).length
							? h('div', { style: Object.assign({}, IS.row, { marginTop: '9px' }) },
								assetDetail.tags.map((t, i) => h('span', { key: 'dt' + i, style: S.tag }, t)))
							: null,
						assetDetail.desc
							? h('p', { style: { margin: '14px 0 0', fontSize: '13.5px', lineHeight: 1.9 } },
								assetDetail.desc)
							: null,
						(assetDetail.facts || []).length
							? h('div', { style: { marginTop: '14px', borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', paddingTop: '12px' } },
								(assetDetail.facts || []).map((f, i) => h('div', {
									key: 'f' + i,
									style: { display: 'flex', gap: '10px', padding: '4px 0', fontSize: '12.5px', lineHeight: 1.75 }
								},
									h('span', { style: { flex: '0 0 64px', color: 'var(--dsw-alias-label-secondary)' } }, f[0]),
									h('span', { style: { flex: '1 1 auto' } }, f[1]))))
							: null,
						h('div', { style: { marginTop: '18px', textAlign: 'right' } },
							h('button', {
								type: 'button', style: S.mini,
								onClick: () => setAssetDetail(null)
							}, '关闭'))))
					: null,
				lightbox ? h('div', {
					style: {
						position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.82)',
						display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
						padding: '24px', cursor: 'zoom-out'
					},
					onClick: closeLightbox
				},
					h('img', {
						style: {
							maxWidth: '96vw', maxHeight: '84vh', objectFit: 'contain',
							borderRadius: '8px', boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
						},
						src: lightbox.src, alt: lightbox.title || 'preview'
					}),
					h('div', { style: { marginTop: '12px', color: '#fff', fontSize: '12.5px', textAlign: 'center' } },
						lightbox.title ? h('div', { style: { fontWeight: 650 } }, lightbox.title) : null,
						lightbox.sub ? h('div', { style: { opacity: 0.75, marginTop: '3px' } }, lightbox.sub) : null,
						h('div', { style: { opacity: 0.5, marginTop: '7px' } }, '点击任意处或按 Esc 关闭'))) : null,
				picker ? (function () {
					let src, title, slot, kind
					if (picker === 'style') {
						src = catalog.styles || []; title = '选风格'; slot = 'style'; kind = 'style'
					} else if (picker === 'layout') {
						src = catalog.layouts || []; title = '选图型'; slot = 'layout'; kind = 'layout'
					} else if (picker === 'color') {
						src = catalog.colors || []; title = '选主题色'; slot = 'color'; kind = 'color'
					} else if (picker === 'scene') {
						// 场景风格：可以挑编号（按生图方式完整展开），也可以直接写名称（原样写入）
						src = catalog.styles || []; title = '选场景风格'; slot = 'scene'; kind = 'style'
					} else {
						// 资产要按 角色 / 道具 / 场景 分组，所以得把分类打在每个条目上
						const cs = (assetLib && assetLib.categories) || {}
						src = ASSET_CATS.reduce((acc, k) => acc.concat(
							((cs[k] && cs[k].items) || []).map((x) => Object.assign({}, x, {
								groupKey: k, group: ASSET_LABEL[k]
							}))), [])
						title = '添加自建资产垫图'; slot = null; kind = 'asset'
					}
					const groups = groupOptions(src)
					const vis = filterItems(src, kind, pickQ, pickGroup)
					return h('div', { style: S.drawer },
						h('button', { type: 'button', style: S.close, onClick: closePicker }, '✕'),
						h('div', { style: S.drawerHead },
							h('h2', { style: { margin: 0, fontSize: '15px' } }, title),
							h('p', { style: S.sub }, src.length + ' 个可选' +
								(slot === 'scene' ? '（挑编号，或直接在下面写名称）'
									: slot ? '（点击即选，再点取消）' : '（可多选，点击切换）')),
							picker === 'scene'
								? h('div', { style: { marginTop: '8px' } },
									h('div', { style: IS.rowWrap },
										h('input', {
											style: Object.assign({}, S.search, { marginTop: 0, maxWidth: '260px' }),
											value: sceneName,
											placeholder: '直接写名称，如：写实 / 电影感实拍摄影',
											onChange: (e) => setSceneName(e.target.value)
										}),
										h('button', {
											type: 'button', style: S.btn,
											onClick: () => {
												const v = sceneName.trim()
												if (!v) { flash('先写一个风格名称'); return }
												setSceneStyle(v); setSceneName(''); closePicker()
											}
										}, '用这个名字'),
										['写实', '电影感实拍摄影', '水墨工笔', '复古美漫'].map((n) => h('button', {
											key: n, type: 'button', style: S.mini,
											onClick: () => { setSceneStyle(n); setSceneName(''); closePicker() }
										}, n))),
									h('p', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
										'名称按技能规范**原样输出、严禁扩写**；只有填编号才会展开成完整生图特征。'))
								: null,
							h('input', {
								style: Object.assign({}, S.search, { marginTop: '8px' }),
								value: pickQ,
								placeholder: picker === 'style'
									? '按编号搜（257 / #18 / FA-018）或名称、作者…'
									: '搜索编号 / 名称 / 关键词…',
								onChange: (e) => setPickQ(e.target.value)
							}),
							h('div', { style: Object.assign({}, IS.subTabs, { marginTop: '8px' }) },
								h('button', {
									type: 'button', style: Object.assign({}, IS.pill, pickGroup === '' ? IS.pillOn : null),
									onClick: () => setPickGroup('')
								}, '全部 ' + src.length),
								groups.map((x) => h('button', {
									key: x.k, type: 'button',
									style: Object.assign({}, IS.pill, pickGroup === x.k ? IS.pillOn : null),
									onClick: () => setPickGroup(pickGroup === x.k ? '' : x.k)
								}, x.label + ' ' + src.filter((it) => it.groupKey === x.k).length)))),
						h('div', { style: S.drawerBody },
							vis.length === 0
								? h('div', { style: S.empty }, '没有匹配的条目')
								: h('div', { style: Object.assign({}, IS.grid, { marginTop: 0 }) },
									vis.map((it) => {
										const on = slot === 'scene'
											? sceneStyle === it.id
											: (slot
												? !!(sel[slot] && sel[slot].id === it.id)
												: assetRefs.some((x) => x.id === it.id))
										return h('button', {
											key: it.id, type: 'button',
											style: Object.assign({}, IS.card, on ? IS.cardOn : null),
											onClick: () => {
												if (slot === 'scene') { setSceneStyle(it.id); closePicker() }
												else if (slot) pick(it, slot)
												else useAsset(it)
											}
										},
											it.img
												? h('img', { style: IS.thumb, src: imgUrl(it), loading: 'lazy', alt: it.id })
												: h('div', { style: Object.assign({}, IS.thumb, { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }) }, '无图'),
											h('div', { style: IS.name }, it.name || it.id),
											h('div', { style: IS.meta }, (it.legacy ? '#' + it.legacy + ' ' : '') + it.id))
									}))))
				})() : null,
				// 生成物归档到资产库：选库 + 起名，保存后即可作为垫图引用
				saveTarget ? h('div', { style: S.drawer },
					h('button', { type: 'button', style: S.close, onClick: () => setSaveTarget(null) }, '✕'),
					h('div', { style: S.drawerHead },
						h('div', { style: IS.idBadge }, '存入资产库'),
						h('h2', { style: { margin: '4px 0 0', fontSize: '15px' } }, '把这张图收进角色 / 道具 / 场景库')),
					h('div', { style: S.drawerBody },
						h('img', {
							style: { width: '100%', borderRadius: '10px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
							src: '/api/workbench/image-asset?p=' + encodeURIComponent(saveTarget.rel_path) + '&from=workspace',
							alt: 'save-target'
						}),
						// 就卡在这里的时候，把「怎么解决」直接放在眼前，而不是让人去别处找入口
						!libReady ? mountPanel() : null,
						h('label', { style: IS.field },
							h('span', { style: IS.label }, '存到哪个库'),
							h('select', {
								style: IS.select, value: saveCat,
								onChange: (e) => setSaveCat(e.target.value)
							}, ASSET_CATS.map((k) => h('option', { key: k, value: k }, ASSET_LABEL[k])))),
						h('label', { style: IS.field },
							h('span', { style: IS.label }, '资产名称'),
							h('input', {
								style: S.search, value: saveName, placeholder: '例如：黑猫侍者',
								onChange: (e) => setSaveName(e.target.value)
							})),
						h('div', { style: IS.meta },
							'保存后会转成 webp 写进外部图库目录、同步镜像并刷新索引。' +
							'之后在「' + ASSET_MOD + '」里就能选它作为垫图，出图时保持主体形象一致。'),
						assetErr ? h('div', { style: S.err }, assetErr) : null,
						h('button', {
							type: 'button',
							style: Object.assign({}, IS.primary, assetBusy ? IS.primaryOff : null),
							onClick: saveToLibrary
						}, assetBusy ? '保存中…' : '确认存入'))
				) : null,
				toast ? h('div', { style: S.toast }, toast) : null
			)
		}

		// 卡片详情抽屉。
		//
		// 图型（图型库）除大图外还要给出**完整生成方法**：
		//   图型原文（中/英，逐字进提示词）+ 固定图文后缀（EC-* 不加）+ 拼装顺序。
		// 这几段必须**与实际发出去的内容一致**，否则"展示的方法"就是假的 ——
		// 所以原文与后缀都由 image-gen.py 提供（界面不自己拼），生成器也用同一份常量。
		function ImageDrawer(props) {
			const it = props.item
			const isPrompt = it.kind === 'prompt'
			const isLayout = !isPrompt && it.kind === 'layout'
			const doc = isLayout ? props.layoutDoc : null
			const zh = isPrompt ? it.promptZh
				: isLayout ? ((doc && doc.zh) || '')
					: (it.kind === 'style'
						? ('风格名称：' + it.name + '。参考作者/风格名称：' + it.author + '。核心风格特征：' + (it.traits || ''))
						: (it.promptZh || it.name || ''))
			const en = isPrompt ? it.promptEn : isLayout ? ((doc && doc.en) || '') : (it.nameEn || '')
			const suffix = (doc && doc.suffixZh) || ''
			const isEc = !!(doc && doc.isEcommerce)
			const zhTitle = isLayout ? '图型原文 · 中文（逐字进提示词）' : '中文提示词'
			const enTitle = isLayout ? '图型原文 · English' : 'English prompt'
			// 资产（角色/道具/场景）：没有提示词可展示，重点是「它是什么」和「拿它出图」。
			// 这一条与风格/图型的抽屉语义不同，别硬套同一套字段。
			const isAsset = !isPrompt && (it.kind === 'asset' || it.kind === 'character')

			const block = (title, body, copyText) => h('div', { style: S.block },
				h('div', { style: S.blockTitle }, title),
				h('div', { style: S.doc }, body),
				copyText ? h('button', { type: 'button', style: S.btn, onClick: () => props.onCopy(copyText) }, '复制') : null)

			return h('div', { style: S.drawer },
				h('button', { type: 'button', style: S.close, onClick: props.onClose }, '✕'),
				h('div', { style: S.drawerHead },
					h('div', { style: IS.idBadge },
						isPrompt ? '提示词预览'
							: (it.legacy ? '#' + it.legacy + ' · ' + it.id : it.id)),
					h('h2', { style: { margin: '4px 0 0', fontSize: '15px' } }, isPrompt ? '组词结果' : (it.name || it.id)),
					!isPrompt && it.author ? h('p', { style: S.sub }, '参考作者/风格名称：' + it.author) : null,
					isPrompt && it.refPath ? h('p', { style: S.sub }, '参考图：' + it.refPath) : null,
					isPrompt && it.mode ? h('p', { style: S.sub },
						'模式：' + (it.mode === 'graphic-text' ? '图文' : '纯图')) : null,
					isPrompt && it.fusion ? h('p', { style: S.sub },
						'风格融合：角色 × 场景 · 共存规范已按技能原文逐字附加') : null,
					isAsset ? h('p', { style: S.sub }, it.isCustom ? '自建资产' : '官方预置资产') : null,
					isLayout && doc && doc.exists
						? h('p', { style: S.sub }, '提示词文件：' + doc.file + '（' + doc.bytes + ' B）') : null
				),
				h('div', { style: S.drawerBody },
					!isPrompt && it.img ? h('img', {
						style: { width: '100%', borderRadius: '10px', border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)' },
						src: props.imgUrl(it), alt: it.id
					}) : null,

					isLayout && !doc ? h('div', { style: S.empty }, '正在读取图型原文…') : null,
					isLayout && doc && !doc.ok ? h('div', { style: S.err }, '读不到图型原文：' + (doc.error || '')) : null,

					!isPrompt && !isLayout && !isAsset && it.traits ? block('核心风格特征', it.traits, null) : null,
					isAsset ? h('div', { style: S.block },
						h('div', { style: S.blockTitle }, '资产信息'),
						h('div', { style: S.doc },
							'编号：' + it.id + '\n' +
							(it.nameEn && it.nameEn !== it.name ? '英文名：' + it.nameEn + '\n' : '') +
							((it.tags || []).length ? '标签：' + it.tags.join(' / ') + '\n' : '') +
							(it.createdAt ? '入库：' + it.createdAt + '\n' : '') +
							(it.layout ? '关联图型：' + it.layout : '')),
						h('div', { style: IS.meta },
							'出图时作为垫图使用：只约束主体形象（外形/比例/配色），画风仍由选中的风格决定。')) : null,
					isAsset ? null : block(zhTitle, zh || '（空）', zh),
					!isAsset && en ? block(enTitle, en, en) : null,
					// 图文模式下可复制提示词不含参考图约束，但实发的那份要含 —— 两者都给人看
					isPrompt && it.sendZh && it.sendZh !== zh
						? block('实际发给模型的提示词（多出参考图 / 资产约束）', it.sendZh, it.sendZh) : null,
					isPrompt && it.decision
						? h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '能力判定（来自技能的 model_capabilities.json）'),
							h('div', { style: S.doc },
								'激活来源：' + (it.decision.activation_source || '—') + '\n' +
								'name_activation：' + (it.decision.name_activation || '—') + '\n' +
								'traits_activation：' + (it.decision.traits_activation || '—') + '\n' +
								'技能建议垫图：' + (it.decision.use_reference_image ? '是' : '否') +
								(it.decision.note ? '\n' + it.decision.note : ''))) : null,

					isLayout && doc && doc.ok ? block(
						isEc ? '固定图文后缀（本图型不追加）' : '固定图文后缀（逐字追加）',
						isEc ? 'EC-* 电商图型按技能规范不追加通用图文后缀，也不自动拼画风（除非明确指定）。' : suffix,
						isEc ? '' : suffix) : null,

					isLayout && doc && doc.ok ? h('div', { style: S.block },
						h('div', { style: S.blockTitle }, '完整生成方法（拼装顺序）'),
						h('div', { style: S.doc },
							'① 风格（风格库选定）：风格名称 + 参考作者 + 核心风格特征\n' +
							'② 主题（生成页输入）\n' +
							'③ 图型原文（上面那段，逐字）\n' +
							(isEc ? '④ ——（EC-* 按规范跳过图文后缀）\n' : '④ 固定图文后缀（上面那段，逐字）\n') +
							'⑤ 参考图使用约束（勾选垫图时追加）'),
						h('div', { style: Object.assign({}, IS.meta, { marginTop: '6px' }) },
							'按 ①→⑤ 拼接；生成页的「预览提示词」就是按这个顺序拼出来的。'),
						zh ? h('button', {
							type: 'button', style: S.btn,
							onClick: () => props.onCopy(zh + (isEc ? '' : suffix))
						}, '复制「图型原文 + 图文后缀」') : null) : null,

					isLayout && doc && doc.ok
						? (props.hasStyle && props.hasTheme
							? h('button', {
								type: 'button', style: S.btn,
								onClick: () => props.onPreview(it)
							}, '按当前组合预览完整提示词')
							: h('div', { style: IS.meta },
								'想看到最终的完整提示词？先到风格库选一个风格、在生成页填上主题，再回到这里点预览。'))
						: null,

					isAsset ? h('button', {
						type: 'button', style: IS.primary,
						onClick: () => { props.onUseAsset(it); props.onClose() }
					}, '以此出图（作为垫图）') : null,

					(!isPrompt && !isAsset) ? h('button', {
						type: 'button', style: IS.primary,
						onClick: () => { props.onPick(it, it.kind === 'layout' ? 'layout' : it.kind === 'color' ? 'color' : 'style'); props.onGenerate() }
					}, it.kind === 'layout' ? '选为图型并去生成' : it.kind === 'color' ? '选为主题色并去生成' : '选为风格并去生成') : null
				)
			)
		}

		function makeApp(app, ctx) {
			// 生图工作台自成一体：它不读 topic_jobs/drafts 那套会话数据，
			// 只走 /api/workbench/image-* 那 5 条路由，所以直接返回自己的组件。
			if (app.key === 'image') {
				// 把模块清单传进去，界面里就不必再硬编码一遍 tab 顺序
				return function ImageStudioView() {
					// 包一层错误边界：渲染抛异常时不要再以"白屏"的形式结束
					return h(PanelBoundary, null, h(ImageStudio, { modules: app.modules }))
				}
			}
			// 顶层「技能库」是插件级入口，不绑定会话数据，也不加载 SQLite——
			// 它只读构建时扫出来的技能注册表。
			if (app.kind === 'registry') {
				return function RegistryView() {
					return h('div', { style: S.page }, h(SkillLibrary))
				}
			}
			return function AppView() {
				const [mod, setMod] = React.useState(app.modules[0])
				const isGzh = app.key === 'gzh'
				const [topics, setTopics] = React.useState([])
				const [jobs, setJobs] = React.useState([])
				const [drafts, setDrafts] = React.useState([])
				const [publishes, setPublishes] = React.useState([])
				const [dbError, setDbError] = React.useState('')
				const [loading, setLoading] = React.useState(isGzh)
				const [pending, setPending] = React.useState({})
				const [selPlan, setSelPlan] = React.useState(null)
			const [selDraft, setSelDraft] = React.useState(null)
			const [selPublish, setSelPublish] = React.useState(null)
			const [preview, setPreview] = React.useState(null)
			// 投递目标会话：{ sessionId, title, how } — 让用户看得见指令会投给谁
			const [targetSession, setTargetSession] = React.useState(null)

			/**
			 * 探测当前会投递到哪个会话。规则与 triggerAgent 保持一致：
			 * ① 标题精确 = Agent-公众号 → ② 标题包含 → ③ 退回最近更新。
			 * 必须实测，不能靠猜：用户的会话名是随时会改的。
			 */
			const probeTargetSession = React.useCallback(async () => {
				try {
					const remote = ctx && ctx.remote
					if (!remote || !remote.session || typeof remote.session.list !== 'function') {
						setTargetSession({ error: 'remote.session 不可用' })
						return
					}
					const listed = await remote.session.list({})
					const items = ((listed && listed.value && listed.value.items) || [])
						.filter((x) => x && x.origin !== 'subagent' && x.blank !== true)
					const title = (x) => String(x.title || x.name || x.label || x.subject || '').trim()
					const want = TARGET_SESSION_TITLE
					let t = items.find((x) => title(x) === want)
					let how = '精确匹配'
					if (!t) { t = items.find((x) => title(x).indexOf(want) >= 0); how = '包含匹配' }
					if (!t) {
						t = items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
						how = '退回最近更新'
					}
					if (!t) { setTargetSession({ error: '没有可用会话' }); return }
					setTargetSession({
						sessionId: t.sessionId,
						title: title(t) || String(t.sessionId).slice(0, 8),
						how: how
					})
				} catch (err) {
					setTargetSession({ error: String((err && err.message) || err) })
				}
			}, [])

			React.useEffect(() => { probeTargetSession() }, [probeTargetSession])

			// 手动改投递目标：把用户选的 sessionId 存进 localStorage，
			// triggerAgent 的 preferredTitle 参数会优先用它。
			const pickTargetSession = React.useCallback(async (chosen) => {
				try {
					window.localStorage.setItem('dsh-workbench:targetSession', JSON.stringify(chosen))
				} catch (err) { /* localStorage 满或隐私模式，忽略 */ }
				setTargetSession(chosen)
				flash('投递目标已改为：' + (chosen.title || chosen.sessionId))
			}, [])

			// 封面放大预览：{ src, title, sub }
			const [coverBox, setCoverBox] = React.useState(null)
			React.useEffect(() => {
				if (!coverBox) return undefined
				const onKey = (e) => { if (e.key === 'Escape') setCoverBox(null) }
				window.addEventListener('keydown', onKey)
				return () => window.removeEventListener('keydown', onKey)
			}, [coverBox])
				const [dialogRow, setDialogRow] = React.useState(null)
				const [inboxOpen, setInboxOpen] = React.useState(false)
				// 创作配置抽屉：null = 关闭；对象 = 打开（带 preset）。
				// 与 dialogRow 分开是因为两者可以同时存在（入队弹窗上叠配置抽屉），
				// 合用一个 state 会互相清掉。
				const [draftCfg, setDraftCfg] = React.useState(null)
				const [toast, setToast] = React.useState('')

				const flash = (msg) => { setToast(msg); window.setTimeout(() => setToast(''), 2600) }

				// 「生成今日选题」：投递每日批量指令给 Agent。
				// ⚠️ 必须定义在这里（AppView 内部）：它要用 ctx.remote 和 flash，
				// 而这两个都是本作用域的东西。放到模块级会 ReferenceError，
				// 表现为「点了完全没反应」（catch 把错吞了，连提示都弹不出来）。
				const generateDailyTopics = async () => {
					const d = new Date()
					const pad = (n) => String(n).padStart(2, '0')
					const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
					if (!ctx || !ctx.remote || !ctx.remote.session) {
						flash('会话不可用：刷新页面后再试')
						return
					}
					flash('正在投递指令…')
					try {
						await triggerAgent(ctx.remote, flash, dailyTopicPrompt(dateStr))
						flash('已投递今日选题生成指令（10 素材 × 2 方向）')
					} catch (err) {
						const msg = String((err && err.message) || err)
						flash(msg === 'COOLDOWN'
							? '上一轮还在跑，90 秒后再点'
							: '投递失败：' + msg)
					}
				}

				const reloadTopics = React.useCallback(async () => {
					if (!isGzh) return
					try {
						const data = await apiGet('/api/workbench/topics')
						setTopics(data.topics || [])
						setDbError('')
					} catch (err) {
						setDbError(String((err && err.message) || err))
					} finally {
						setLoading(false)
					}
				}, [isGzh])

				const reloadJobs = React.useCallback(async () => {
					if (!isGzh) return
					try {
						const data = await apiGet('/api/workbench/jobs')
						setJobs(data.jobs || [])
						setDbError('')
					} catch (err) {
						setDbError(String((err && err.message) || err))
					}
				}, [isGzh])

				React.useEffect(() => { reloadTopics(); reloadJobs() }, [reloadTopics, reloadJobs])

				const reloadDrafts = React.useCallback(async () => {
					if (!isGzh) return
					try {
						const data = await apiGet('/api/workbench/drafts')
						setDrafts(data.drafts || [])
						setDbError('')
					} catch (err) {
						setDbError(String((err && err.message) || err))
					}
				}, [isGzh])

				React.useEffect(() => { reloadDrafts() }, [reloadDrafts])

				React.useEffect(() => {
					if (!isGzh) return
					if (mod === '发布管理') {
						apiGet('/api/workbench/publishes').then(
							(d) => setPublishes(d.publishes || []),
							(err) => setDbError(String((err && err.message) || err)))
					}
				}, [mod, isGzh])

				// 选题库「选为写作」→ **只打开创作配置**，不建草稿、不触发写作。
				// 这是本次改造的关键：选题方案只决定「写什么」，「怎么写」要在配置里由人定。
				//
				// ⚠️ 2026-10-26 修：原来读 topic.source_summary —— 那个字段根本不存在，
				// 所以参考素材永远是空的（截图复现）。viewpoint 28/28 也全空。
				// 真正有值的是选题自己蒸馏出来的几段，按有哪段带哪段拼，缺就留空、不编造。
				const openConfig = (topic) => {
					const dg = parseJson(topic.digests_json, [])
					const facts = parseJson(topic.material_facts, [])
					const missing = parseJson(topic.material_missing, [])
					const parts = []

					// ── 素材事实放最前：这是写作唯一的事实来源，比摘要重要得多 ──
					// 2026-11-08 修：以前只拼摘要+角度+钩子，新流程拆出的 material_facts
					// 一条都没传，Agent 拿不到具体数字只能靠猜，于是编造。
					if (facts.length) {
						parts.push('【素材事实】（逐条列出，写作时只能用这些，不许新增数字）\n' +
							facts.map((f) => '- ' + f).join('\n'))
					}
					if (missing.length) {
						// 2026-11-10：缺口加使用规则。
						// 原来只说「避开或明说」，结果被写成了文章主体（立冬那篇占 40%）。
						parts.push('【素材缺口】（报道没给的信息）\n' +
							missing.map((f) => '- ' + f).join('\n') +
							'\n\n**使用规则（硬性）**：\n' +
							'· 只能半句带过，如「报道里没提」「这一条没有公开说明」\n' +
							'· 不得单独成节，不得单独成段\n' +
							'· 缺口相关内容总量 ≤ 全文 15%\n' +
							'· 缺口是用来守住事实边界的，不是用来撑篇幅的')
					}

					if (topic.source_title) parts.push('【来源】' + topic.source_title)
					if (dg.length) parts.push('【摘要】' + dg[0])

					// ── 新流程字段：命题 / 方向 / 读者三问 ──
					if (topic.public_theme) parts.push('【公共命题】' + topic.public_theme)
					if (topic.topic_role) parts.push('【选题方向】' + topic.topic_role)
					if (topic.reader_why_click) parts.push('【读者为什么点】' + topic.reader_why_click)
					if (topic.reader_what_get) parts.push('【读完得到什么】' + topic.reader_what_get)
					if (topic.reader_why_share) parts.push('【为什么会转发】' + topic.reader_why_share)

					// ── 旧字段兜底（老选题没有新字段时才显示）──
					if (!topic.public_theme && topic.angle) parts.push('【切入角度】' + topic.angle)
					if (!topic.reader_why_click && topic.hook) parts.push('【钩子】' + topic.hook)
					if (!topic.reader_what_get && topic.payoff) parts.push('【读者收获】' + topic.payoff)
					// persona 与 reader_why_click 相同就不重复输出：
					// 新流程入库时 persona 复用了 reader_why_click 的值，
					// 两条并排出现读起来像啰嗦，也白占 token。
					if (topic.persona && topic.persona !== topic.reader_why_click) {
						parts.push('【目标读者】' + topic.persona)
					}

					setDraftCfg({
						topicId: topic.id,
						title: topic.best_title || topic.title || '',
						theme: topic.best_title || topic.title || '',
						materials: parts.join('\n\n'),
						// 核心角度：2026-11-10 改回以 viewpoint（作者观点）为主。
						// 原来的顺序是 public_theme 优先，理由是「viewpoint 全空」——
						// 但那是在绕 bug：提示词根本没问 viewpoint。
						// public_theme 是命题（属于哪个话题），不是主张（作者站哪边）。
						// 用命题顶替主张，写出来就是资讯整理，必然发散。
						requirement: topic.viewpoint || topic.public_theme || '',
						// 主论点：2026-11-10 新增，独立于「核心角度」。
						// 核心角度是「从哪看」，主论点是「要说什么」——两件事。
						// 只有主论点会被当成全文唯一方向标：每节为它服务、结尾回扣它。
						thesis: topic.viewpoint || '',
						// 切入角度独立取值，不再用 public_theme 顶替
						angle: topic.angle || '',
						genre: topic.track || '',
						// 结构类型带进配置，写作时 structureRulesText 会把它标成「本篇选它」
						structureType: topic.structure_type || '',
						topicRole: topic.topic_role || ''
					})
				}

				// 手工「开始创作」→ 建草稿 → 触发写作。只有这里会真的开跑。
				// 配置里选了写作技能就按它写（skillClass 一起传，A/B 门禁不同）；
				// 没选就留空，让数据层兜底路由（老选题兼容）。
				const startDraft = async (cfg) => {
					setPending((p) => Object.assign({}, p, { draft: true, draftId: cfg.draftId || 'new' }))
					try {
						// 改配置：回写已有草稿，不新建。否则同一个选题会攒出多条重复稿。
						if (cfg.draftId) {
							const upd = await apiPost('/api/workbench/drafts', {
								op: 'set-draft',
								id: cfg.draftId,
								title: cfg.title,
								theme: cfg.theme,
								materials: cfg.materials,
								requirement: cfg.requirement,
								// viewpoint 存主论点，不是存 requirement 的副本。
								// 主论点是「要说什么」，requirement 是「从哪看」，两件事。
								viewpoint: cfg.thesis || cfg.requirement,
								topicId: cfg.topicId,
								track: cfg.genre,
								skill: cfg.skill,
								skillClass: cfg.skillClass,
								// structureType / topicRole 必须存进 configJson：
								// 否则推进阶段从 DB 读 draft 时拿不到，
								// 结构规范里的「本篇选它」标记会消失。
								configJson: JSON.stringify(Object.assign({}, cfg.config || {}, {
									structureType: cfg.structureType || '',
									topicRole: cfg.topicRole || ''
								}))
							})
							if (!upd || upd.ok === false) throw new Error((upd && upd.error) || '回写配置失败')
							await Promise.all([reloadTopics(), reloadDrafts()])
							setDraftCfg(null)
							try {
								await triggerAgent(ctx.remote, null, writingPrompt({
									id: cfg.draftId, title: cfg.title,
									theme: cfg.theme, requirement: cfg.requirement,
									// thesis / topicId 必须传：不传的话 writingPrompt 里
									// 【主论点】整段不会出现，等于这次升级没生效。
									thesis: cfg.thesis, topicId: cfg.topicId,
									// materials 以前没传，导致 writingPrompt 里
									// `if (focus.materials)` 那段永远不执行，素材只留在 DB 里
									materials: cfg.materials,
									structureType: cfg.structureType,
									skill: cfg.skill, skillClass: cfg.skillClass,
									words: cfg.config && cfg.config.words,
									styleCode: cfg.config && cfg.config.styleCode,
									styleName: cfg.config && cfg.config.styleName,
									styleBody: cfg.config && cfg.config.styleBody,
									skeleton: cfg.config && cfg.config.skeleton
								}))
								flash('已按新配置开始创作：' + cfg.skill +
									(cfg.config && cfg.config.styleName ? '｜风格 ' + cfg.config.styleName : ''))
							} catch (terr) {
								const msg = String((terr && terr.message) || terr)
								flash(msg === 'COOLDOWN' ? '配置已存，上一轮还在跑，稍后自动接上'
									: '配置已存，但触发写作失败：' + msg)
							}
							return
						}
						const res = await apiPost('/api/workbench/drafts', {
							action: 'create',
							topicId: cfg.topicId || null,
							title: cfg.title,
							theme: cfg.theme,
							materials: cfg.materials,
							requirement: cfg.requirement,
							// 主论点单独存，不存 requirement 的副本
							viewpoint: cfg.thesis || cfg.requirement,
							track: cfg.genre,
							skill: cfg.skill,
							skillClass: cfg.skillClass,
							config: Object.assign({}, cfg.config || {}, {

							    // structureType / topicRole 一起存：推进阶段要能从 DB 读回来

							    structureType: cfg.structureType || '',

							    topicRole: cfg.topicRole || ''

							})
						})
						await Promise.all([reloadTopics(), reloadDrafts()])
						setDraftCfg(null)
						try {
							await triggerAgent(ctx.remote, null, writingPrompt({
								id: res.id, title: res.title,
								theme: cfg.theme, requirement: cfg.requirement,
								// 新建草稿这条路径也要传，否则新稿永远是「没有主论点」的老样子
								thesis: cfg.thesis, topicId: cfg.topicId,
								materials: cfg.materials,
								structureType: cfg.structureType,
								skill: res.skill, skillClass: res.skillClass,
								words: cfg.config && cfg.config.words,
								styleCode: cfg.config && cfg.config.styleCode,
								styleName: cfg.config && cfg.config.styleName,
								styleBody: cfg.config && cfg.config.styleBody,
								skeleton: cfg.config && cfg.config.skeleton
							}))
							flash('已开始创作：' + res.skill + '（' + res.skillClass + ' 类）' +
								(cfg.config && cfg.config.styleName ? '｜风格 ' + cfg.config.styleName : ''))
						} catch (terr) {
							const msg = String((terr && terr.message) || terr)
							flash(msg === 'COOLDOWN'
								? '草稿已建：上一轮还在跑，稍后会自动接上'
								: '草稿已建，但触发写作失败：' + msg)
						}
					} catch (err) {
						flash('建草稿失败：' + String((err && err.message) || err))
					} finally {
						setPending((p) => { const n = Object.assign({}, p); delete n.draft; delete n.draftId; return n })
					}
				}

				// 创作库「＋ 新建创作」：全空配置，不挂选题
				const newConfig = () => {
					setDraftCfg({ topicId: null, title: '', theme: '', materials: '', requirement: '', genre: '' })
				}

				// 待写草稿「改配置」：带入已有配置，改完走 set-draft 回写
				const reconfigDraft = (draft) => {
					let cfg = {}
					try { cfg = JSON.parse(draft.config_json || '{}') } catch (err) { cfg = {} }
					setDraftCfg({
						draftId: draft.id,
						topicId: draft.topic_id || null,
						title: draft.title || '',
						theme: draft.theme || draft.title || '',
						materials: draft.materials || '',
						requirement: draft.requirement || draft.viewpoint || '',
						genre: draft.track || '',
						skill: draft.skill || '',
						// 整块传下去，让抽屉把字数/风格/偏好一起回显（不是只回显字数）。
						config: cfg
					})
				}

				// 推进草稿到下一阶段
				// ⚠️ 风格必须一起带上：否则「写稿」用风格、「打磨/审稿」丢风格，
				// 后面几轮会把风格改回去。
				// 手工配图指令（2026-11-10 加）。
				// 配图从自动流程里摘出来了：文章还可能改，改了就得重配，白烧额度。
				// 只有用户在 formatted 阶段点「配图」并确认文章定稿，才会走这条。
				function composeImagesPrompt(draft) {
					const dir = (draft.path || '').replace(/\/$/, '')
					return [
						'[手工配图] draft #' + draft.id + '《' + (draft.title || '') + '》',
						'',
						'用户已确认这篇文章定稿，现在要配图。草稿目录：' + dir,
						'',
						'1) 先读 `dsh-workbench/配图路线.md` 定媒介。**封面按新规范：整幅画面，不允许纯色留白区。**',
						'2) 查这篇草稿的 config_json 里的 styleCode，按风格决定配图策略。',
						'3) 用 image-gen 生成封面（2.35:1）+ 正文图（16:9），数量按图位数来，不多不少。',
						'4) 生成后逐张看图。封面必须人工回看：主体够不够大、345px 下认不认得出、有没有纯色块。',
						'5) 跑 check-cover.py 和 check-image-log.py（日志是 UTF-16）。',
						'6) 图放进 imgs/（cover.png + img-01.png…），回写 cover / imagesCount。',
						'7) **不带 --allow-placeholder 重跑 finalize.py**，把真图插进 article.html。',
						'8) 跑 check-all.py --stage=layout 确认。回写 status=illustrated。',
						'',
						'⛔ 不要改正文。配图这一步只处理图。'
					].join('\n')
				}

				const composeImages = async (draft) => {
					setPending((p) => Object.assign({}, p, { advance: true, advanceId: draft.id }))
					try {
						await triggerAgent(ctx.remote, null, composeImagesPrompt(draft))
						flash('已投递给 Agent 配图：' + (draft.title || '').slice(0, 16))
					} catch (err) {
						const msg = String((err && err.message) || err)
						flash(msg === 'COOLDOWN' ? '上一轮还在跑，稍后再点' : '投递失败：' + msg)
					} finally {
						setPending((p) => { const n = Object.assign({}, p); delete n.advance; delete n.advanceId; return n })
					}
				}

				const advanceDraft = async (draft) => {
					setPending((p) => Object.assign({}, p, { advance: true, advanceId: draft.id }))
					try {
						let cfg = {}
						try { cfg = JSON.parse(draft.config_json || '{}') } catch (err) { cfg = {} }
						await triggerAgent(ctx.remote, null, writingPrompt({
							id: draft.id, title: draft.title, from: draft.status,
							theme: draft.theme || '',
							requirement: draft.requirement || '',
							// 推进阶段从 DB 把主论点读回来。不读的话，
							// 「继续写」「打磨」这些操作会丢掉主论点，
							// 后半程又变成没有方向的状态。
							thesis: draft.viewpoint || '',
							topicId: draft.topic_id,
							// 推进阶段也要带素材：否则「开始写」时 Agent 手里没事实
							materials: draft.materials || '',
							structureType: cfg.structureType || '',
							skill: draft.skill || '', skillClass: draft.skill_class || '',
							words: cfg.words,
							styleCode: cfg.styleCode, styleName: cfg.styleName, styleBody: cfg.styleBody,
							skeleton: cfg.skeleton
						}))
						flash('已触发：' + (DRAFT_ACTION[draft.status] || '推进'))
					} catch (terr) {
						const msg = String((terr && terr.message) || terr)
						flash(msg === 'COOLDOWN' ? '上一轮还在跑，稍后再试' : '触发失败：' + msg)
					} finally {
						setPending((p) => { const n = Object.assign({}, p); delete n.advance; delete n.advanceId; return n })
					}
				}

				// 读全文（node 半从宿主磁盘读，并做 markdown → HTML）
				const openPreview = async (draft) => {
					setPreview({ title: draft.title, file: '', text: '', html: '', loading: true, error: '' })
					try {
						const data = await apiGet('/api/workbench/draft-content?id=' + draft.id)
						setPreview({
							title: draft.title, file: data.file, text: data.text || '',
							html: data.html || '', kind: data.kind, sourceFile: data.sourceFile,
							loading: false, error: ''
						})
					} catch (err) {
						setPreview({
							title: draft.title, file: '', text: '', html: '', loading: false,
							error: '读不到全文：' + String((err && err.message) || err)
						})
					}
				}

				const removeDraft = async (draft) => {
					try {
						await apiPost('/api/workbench/drafts', { action: 'delete', id: draft.id })
						setSelDraft(null)
						flash('已删除草稿')
						await reloadDrafts()
					} catch (err) {
						flash('删除失败：' + String((err && err.message) || err))
					}
				}

				// 两段式的第一段：只入队，不当场产生选题
				// 手动投料：存盘 → 投递分析指令
				// 不直接写选题库：让 Agent 先判断这条素材信息够不够
				const submitInbox = async (text, images) => {
					const res = await apiPost('/api/workbench/inbox', { text, images })
					if (!res || !res.ok) throw new Error((res && res.error) || '保存失败')
					const rec = res.record || {}
					const paths = (rec.images || []).map((x) => '- ' + x.path)
					const lines = [
						'[工作台·手动投料] 用户投了一段素材，请分析后再决定去处。',
						'',
						'**素材文字**：',
						text || '（用户只给了图片，没写字）',
						''
					]
					if (paths.length) {
						lines.push('**截图**（先用 read_image 逐张读，再下判断）：')
						lines.push.apply(lines, paths)
						lines.push('')
					}
					lines.push(
						'落盘位置：' + (rec.dir || 'materials/inbox/') + '（另有同名 .json 记录）',
						'',
						'请按顺序做：',
						'1) 提炼**事实锚点**：原话、数字、时间、人物、关键动作。信息不足就直说缺什么，**不要补写或推测**。',
						'2) 判断去处：够不够直接出选题？够则给 2-3 个角度（每个带一句话立场与候选标题）；不够则说明该补哪条素材。',
						'3) 如果有疑点（截图看不清、来源不明、数字矛盾），明确指出。',
						'4) 简短回报，不要把素材原文整段贴回对话。',
						'',
						'注意：**不要自动写进选题库或创作库**，等用户看完你的判断再决定。'
					)
					await triggerAgent(ctx.remote, flash, lines.join('\n'))
					flash('已存下素材并投递分析指令')
				}

				const enqueue = async (row, preset) => {
					setPending((p) => Object.assign({}, p, { [row.key]: true }))
					try {
						const res = await apiPost('/api/workbench/jobs', {
							title: row.title, platform: row.platform, hot: row.hot,
							url: row.url, date: row.date, key: row.key,
							// 赛道（genre）：决定路由到哪个 skill，与账号定位无关
							track: (preset && preset.genre) || guessGenre(row),
							preset: preset || null,
							note: '来自 ' + row.date + ' ' + row.platform + ' 热榜' +
								(preset && preset.count ? '；预设 ' + preset.count + ' 个角度' : '')
						})
						await reloadJobs()
						// 合并触发：队列里没有 running 的任务时才投递分析指令
						// （连点多条只会跑一轮，而不是每条一轮）
						const jobList = await apiGet('/api/workbench/jobs')
						const busy = (jobList.jobs || []).some((j) => j.status === 'running')
						if (res.updated) {
							flash('已在队列里，预设已更新')
						} else if (res.duplicate) {
							flash('这条已经分析过了（' + (res.status || '—') + '），不再重复入队')
						} else if (busy) {
							flash('已入队：分析进行中，这批会一起处理')
						} else {
							try {
								// 带上 focus：让 Agent 优先处理用户刚点的这条，而不是 FIFO 最旧的
								await triggerAgent(ctx.remote, null, analysisPrompt({ id: res.id, title: row.title }))
								flash('已入队并触发分析：' + row.title.slice(0, 14))
							} catch (terr) {
								const msg = String((terr && terr.message) || terr)
								flash(msg === 'COOLDOWN'
									? '已入队：上一轮分析还在跑，这批会一起处理'
									: '已入队，但触发分析失败：' + msg)
							}
						}
					} catch (err) {
						flash('入队失败：' + String((err && err.message) || err))
					} finally {
						setPending((p) => { const n = Object.assign({}, p); delete n[row.key]; return n })
					}
				}

				const topicStatus = async (row, status) => {
					setPending((p) => Object.assign({}, p, { status: true }))
					try {
						await apiPost('/api/workbench/topics', { action: 'set-status', id: row.id, status })
						setSelPlan((cur) => (cur && cur.id === row.id ? Object.assign({}, cur, { status }) : cur))
						flash(status === 'selected' ? '已选定，可以建草稿了' : '已改回候选')
						await reloadTopics()
					} catch (err) {
						flash('改状态失败：' + String((err && err.message) || err))
					} finally {
						setPending((p) => { const n = Object.assign({}, p); delete n.status; return n })
					}
				}

				const removeTopic = async (row) => {
					setPending((p) => Object.assign({}, p, { remove: true }))
					try {
						await apiPost('/api/workbench/topics', { action: 'delete', id: row.id })
						setSelPlan(null)
						flash('已删除该选题方案')
						await reloadTopics()
					} catch (err) {
						flash('删除失败：' + String((err && err.message) || err))
					} finally {
						setPending((p) => { const n = Object.assign({}, p); delete n.remove; return n })
					}
				}

				// 素材行的状态：入队了还是已出选题
				const rowState = {}
				jobs.forEach((j) => { if (j.source_key) rowState[j.source_key] = (j.status === 'done' ? 'analyzed' : 'queued') })
				topics.forEach((t) => { if (t.source_key) rowState[t.source_key] = 'analyzed' })

				let view
				if (mod === '技能包') view = h(SkillPack, { pack: app.pack })
				else if (mod === '每日热榜') view = h(HotRankLibrary, {
					rowState, pending, onPick: (row) => setDialogRow(row), error: dbError,
					onInbox: submitInbox, onOpenInbox: () => setInboxOpen(true),
					targetSession: targetSession, onPickSession: pickTargetSession
				})
				else if (mod === '爆文库') view = h(ViralLibrary, {
					rowState, pending, onPick: (row) => setDialogRow(row), error: dbError
				})
				else if (mod === '选题库') view = h(TopicLibrary, {
					topics, jobs, drafts, loading, error: dbError, sel: selPlan, busy: !!pending.draft,
					onOpen: setSelPlan, onStatus: topicStatus, onRemove: removeTopic,
					onCreateDraft: openConfig,
					onGenerateDaily: generateDailyTopics
				})
				else if (mod === '风格库') view = h(StyleLibrary, { onToast: flash })
				else if (mod === '创作库') view = h(DraftLibrary, {
					drafts, loading, error: dbError, sel: selDraft, busy: !!pending.advance || !!pending.draft,
					runningId: pending.advanceId || pending.draftId || null,
					onOpen: setSelDraft, onAdvance: advanceDraft, onRemove: removeDraft,
					onPreview: openPreview,
					onZoomCover: (src, title, sub) => setCoverBox({ src, title, sub }),
					onNewConfig: newConfig, onReconfig: reconfigDraft,
					onComposeImages: composeImages
				})
				else if (mod === '发布管理') view = h(PublishLibrary, {
					publishes, loading: false, error: dbError, sel: selPublish,
					onOpen: setSelPublish, onToast: flash
				})
				else view = h('div', { style: S.body },
					h('div', { style: S.head }, h('h1', { style: S.h1 }, app.label + ' · ' + mod),
						h('p', { style: S.sub }, '这个工作台的模块待实现。')),
					h('div', { style: S.placeholder }, '（空视图）'))

				const waiting = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length
				return h('div', { style: S.page },
					h('div', { style: S.tabs },
						app.modules.map((m) => h('button', {
							key: m, type: 'button',
							style: Object.assign({}, S.tab, mod === m ? S.tabOn : S.tabOff),
							onClick: () => setMod(m)
						}, m)),
						isGzh
							? h('span', { style: { marginLeft: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
								'选题方案 ' + topics.length + ' 个' + (waiting ? ' · 待分析 ' + waiting + ' 条' : ''))
							: null),
					view,
					preview ? h(TextPreview, {
						title: preview.title, file: preview.file, text: preview.text, html: preview.html,
						kind: preview.kind, sourceFile: preview.sourceFile,
						loading: preview.loading, error: preview.error,
						onClose: () => setPreview(null), onToast: flash
					}) : null,
					// 封面放大：点创作库的封面缩略图打开。交互照生图工作台那套——
					// 点击任意处或按 Esc 关闭，不抢鼠标。
					coverBox ? h('div', {
						style: {
							position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.85)',
							display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
							padding: '28px', cursor: 'zoom-out'
						},
						onClick: () => setCoverBox(null)
					},
						h('img', {
							style: {
								maxWidth: '92vw', maxHeight: '78vh', objectFit: 'contain',
								borderRadius: '8px', boxShadow: '0 24px 70px rgba(0,0,0,0.55)'
							},
							src: coverBox.src, alt: coverBox.title || '封面预览'
						}),
						h('div', {
							style: {
								marginTop: '14px', color: '#fff', fontSize: '12.5px',
								textAlign: 'center', maxWidth: '80vw'
							},
							// 点按钮区不关闭弹层——否则想点下载会先把弹层关掉
							onClick: (e) => e.stopPropagation()
						},
							coverBox.title ? h('div', { style: { fontWeight: 650, lineHeight: 1.5 } }, coverBox.title) : null,
							coverBox.sub ? h('div', { style: { opacity: 0.7, marginTop: '4px' } }, coverBox.sub) : null,
							// 下载：<a download> 直接存文件，不走 JS 拼 Blob。
							// 文件名用草稿标题，清掉文件系统不接受的字符。
							h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'center' } },
								h('a', {
									href: coverBox.src,
									download: (String(coverBox.title || '封面')
										.replace(/[\\/:*?"<>|]/g, '_')
										.slice(0, 40) || '封面') + '-封面.png',
									style: {
										padding: '7px 18px', borderRadius: '8px', cursor: 'pointer',
										background: 'rgba(255,255,255,0.94)', color: '#111',
										fontSize: '13px', fontWeight: 600, textDecoration: 'none',
										display: 'inline-block'
									},
									onClick: (e) => e.stopPropagation()
								}, '下载封面'),
								h('button', {
									type: 'button',
									style: {
										padding: '7px 16px', borderRadius: '8px', cursor: 'pointer',
										background: 'transparent', color: 'rgba(255,255,255,0.85)',
										border: '1px solid rgba(255,255,255,0.35)', font: 'inherit', fontSize: '13px'
									},
									onClick: () => setCoverBox(null)
								}, '关闭')),
							h('div', { style: { opacity: 0.45, marginTop: '10px' } }, '点击任意处或按 Esc 关闭'))) : null,
					dialogRow ? h(EnqueueDialog, {
						row: dialogRow,
						onClose: () => setDialogRow(null),
						onConfirm: (row, preset) => enqueue(row, preset)
					}) : null,
					draftCfg ? h(DraftConfig, {
						preset: draftCfg,
						onClose: () => setDraftCfg(null),
						onStart: startDraft,
						onToast: flash
					}) : null,
					inboxOpen ? h(InboxDialog, {
						onClose: () => setInboxOpen(false),
						onSubmit: async (text, images) => {
							try {
								await submitInbox(text, images)
								setInboxOpen(false)
							} catch (err) {
								throw err      // 让弹窗自己显示错误，不要静默关掉
							}
						}
					}) : null,
					toast ? h('div', { style: S.toast }, toast) : null
				)
			}
		}

		const inject = ['slots', 'remote', 'remote.session']

		function apply(ctx) {
			APPS.forEach((app) => {
				ctx.slots.inject('main', () => ctx.slots.register(
					{ name: 'main', key: app.key, label: app.label }, makeApp(app, ctx)))
				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
					{ name: 'sidebar.panellist', id: app.key, label: app.label, order: 100 }, Icon(app)))
			})
		}

		return { name: 'dsh-workbench', inject, apply }
	}
})
