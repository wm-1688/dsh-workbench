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
		const SKILL_REGISTRY = {
 "skills": [],
 "packs": [
  {
   "key": "gzh",
   "title": "公众号创作技能包",
   "count": 0
  },
  {
   "key": "image",
   "title": "生图技能包",
   "count": 0
  }
 ]
}
		const SKILL_PACKS = {
 "gzh": {
  "title": "公众号创作技能包",
  "stages": [
   {
    "name": "1 发现热点",
    "mode": "脚本",
    "note": "hot-topics 的 60s API；或 collect-source-material list toutiao（50 条）"
   },
   {
    "name": "2 采集与补素材",
    "mode": "脚本",
    "note": "collect-source-material fetch <url>"
   },
   {
    "name": "3 选材与选题",
    "mode": "Agent + 技能",
    "note": "select-entertaining-materials / bigpeng-hot-gzh / aws-wechat-article-topics"
   },
   {
    "name": "4 定角度",
    "mode": "Agent + 技能",
    "note": "develop-entertainment-article-angles"
   },
   {
    "name": "5 写正文",
    "mode": "Agent + 技能（按赛道配置）",
    "note": "write-entertainment-… / aws-…-writing / khazix-writer 三选一"
   },
   {
    "name": "6 打磨",
    "mode": "Agent + 技能",
    "note": "lieflat-less-ai-tone：白名单式，11 条规则逐条比对 + 文末验收清单 + 信息守恒。没命中规则的句子必须逐字保留（写死在 SKILL.md 的硬性边界里）。打磨后跑 tools/check-draft.py 按写作技能复核 L1（A 类=aws 配额，B 类=卡兹克规则）"
   },
   {
    "name": "7 自检",
    "mode": "脚本",
    "note": "write.py check（本阶段无独立技能，由 aws-wechat-article-writing 自带脚本执行）"
   },
   {
    "name": "8 审稿定稿",
    "mode": "Agent + 技能 + 脚本",
    "note": "aws-wechat-article-review + write.py strip-citations"
   },
   {
    "name": "9 配图",
    "mode": "脚本（Agent 写 prompt）",
    "note": "image_create.py generate / batch"
   },
   {
    "name": "10 排版",
    "mode": "脚本",
    "note": "format.py"
   },
   {
    "name": "11 发布",
    "mode": "脚本",
    "note": "publish.py full（需微信凭证）"
   },
   {
    "name": "总控与资产",
    "mode": "Agent + 技能",
    "note": "一条龙总控入口 + 业务资料库与预设包"
   }
  ],
  "skills": []
 },
 "image": {
  "title": "生图技能包",
  "stages": [
   {
    "name": "1 选风格/图型/色卡",
    "mode": "界面",
    "note": "风格库 324 风格 / 161 图型 / 36 主题色，与 handraw-style 画廊同一份 references/*.json"
   },
   {
    "name": "2 组提示词",
    "mode": "脚本",
    "note": "image-gen.py preview（提示词只组一次，预览与实际出图共用，避免两套模板）"
   },
   {
    "name": "3 垫图出图",
    "mode": "脚本",
    "note": "image-gen.py run → POST /v1/api/generate，编号参考图走 images 数组（实测形状）"
   },
   {
    "name": "4 归档与计费",
    "mode": "脚本",
    "note": "image-db.py（image_assets 资产库 + image_usage 计费账本；接口没有配额端点）"
   },
   {
    "name": "5 用到公众号",
    "mode": "Agent + 技能",
    "note": "出好的图可直接进配图 / 贴图链路"
   }
  ],
  "skills": []
 }
}
		const MATERIALS = {
 "fetchedAt": "",
 "date": "",
 "platforms": [],
 "rows": []
}

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
		// 赛道词表 = 两组并存，共 16 个（下拉直接由这里生成，加词只改这一处）。
		//
		// ① 通用赛道 8 个，由平台分类体系的 43 个分类归并而来（2026-10-09）。
		//    只有「娱乐与情感」和「AI 与科技」会改变技能路由；其余走同一套，
		//    分开是为了库里能筛选、以及让 Agent 知道该往哪个方向找角度。
		// ② 情感成长赛道 8 个（2026-11-16 按用户给定的分类表追加）。
		//    覆盖方向写在旁边——「赛道」影响的是「往哪个方向找角度」，
		//    这一列就是给 Agent 看的选题方向约束，别只当标签用：
		//      女性成长  自我价值 / 独立 / 选择
		//      健康养生  作息 / 饮食 / 身体信号
		//      人生感悟  经历 / 取舍 / 中年
		//      两性关系  沟通 / 边界 / 亲密
		//      婚姻经营  分工 / 冲突 / 长期
		//      情绪心理  内耗 / 焦虑 / 自处
		//      亲子家庭  养育 / 代际 / 陪伴
		//      职场成长  选择 / 边界 / 转型
		//
		// ── 赛道体系（2026-11-18 重构为 5 个一级 + 15 个二级垂类）──
		//
		// 一级赛道只做**展示分组**，不入库：一个内容只归一个二级垂类，
		// 一级纯粹是分组，入库要同步两份、还会出现「一级对、二级错」的组合。
		//
		// 设计依据：MECE（相互独立、完全穷尽）+ 从宏观到微观、从硬资讯到软内容。
		const TRACK_GROUPS = [
			{ label: '时事与社会', items: ['社会民生', '国际与时事'] },
			{ label: '科技与商业', items: ['AI 与科技', '财经与商业'] },
			{ label: '生活与文化', items: ['文化与生活', '娱乐', '体育', '健康'] },
			{ label: '教育与家庭', items: ['教育', '亲子家庭'] },
			{ label: '个人成长与情感', items: ['职场', '情绪心理', '两性关系', '女性成长', '人生感悟'] }
		]
		// 平铺清单由分组派生 —— **不要手写第二份**，否则加一个垂类要改两处、必然漏一处。
		const GENRES = TRACK_GROUPS.reduce((a, g) => a.concat(g.items), [])

		/** 反查某个二级垂类属于哪个一级（列表里显示上级用）。查不到返回空串。 */
		function trackParent(track) {
			const t = String(track || '')
			if (!t) return ''
			for (const g of TRACK_GROUPS) {
				if (g.items.indexOf(t) >= 0) return g.label
			}
			return ''
		}

		// 选它表示「不预设」：track 存空串，由 Agent 在选题时按标题判断。
		// 为什么不把它当一个赛道（2026-11-18）：它不是分类，是"自动化功能"——
		// 由 Agent 建稿时自己定。放进赛道列表会让统计出现「自动判断」这一档，
		// 但它不指向任何内容主题。保留下拉选项是因为用户确实需要"让 Agent 决定"。
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
			// ── 15 个二级垂类的预填规则（2026-11-18 按新体系重排）──
			//
			// **顺序是这段代码里唯一重要的东西**：越具体、越不容易误判的越靠前。
			// 排在后面的会用更宽的词兜底，一旦顺序错了，
			// 「带娃焦虑」会被判成职场/情绪，而不是亲子家庭。
			//
			// 预填只是建议值：用户看到不对手动改即可，所以这里追求「多数时候对」，
			// 不追求「绝不判错」（那不可能，标题信息量本来就不够）。

			// AIHOT 两个频道直接归科技，不用看标题
			if (p === 'AI·热点' || p === 'AI·资讯') return 'AI 与科技'
			// 「网传X系AI编造」是辟谣新闻，归社会民生，别被 AI 两字带走
			if (/AI 编造|AI造谣|系AI|AI生成.*谣言/.test(s)) return '社会民生'

			// ① 先判最具体的垂类（专业词密度最高、误判率最低）
			if (/国足|球|赛季|夺冠|奥运|全运|运动员|冠军|比赛|球队|联赛|亚锦赛|世界杯|中超/.test(s)) return '体育'
			if (/健身|养生|健康|医疗|疾病|疫苗|体检|睡眠|作息|减肥|血压|血糖|血管|癌|手术|医生|医院|营养|长寿/.test(s)) return '健康'
			if (/育儿|带娃|宝宝|婴儿|幼儿|辅食|断奶|二胎|三胎|亲子|陪伴|代际|隔代|月子|产假|全职妈妈/.test(s)) return '亲子家庭'
			if (/焦虑|抑郁|内耗|情绪|心理|自愈|疗愈|压力|崩溃|失眠|孤独|自我怀疑|心态|正念|冥想/.test(s)) return '情绪心理'
			if (/恋爱|爱情|婚姻|出轨|复合|分手|相亲|择偶|彩礼|婚外情|异地恋|婆媳|两性|亲密关系|暧昧|前任/.test(s)) return '两性关系'
			if (/女性|女人|全职太太|独立女性|女性觉醒|性别|女权|中年女性|职场女性|剩女|产后|大女主|女性主义/.test(s)) return '女性成长'
			if (/高考|考研|中考|学校|老师|教师|上学|入学|招生|考试|课堂|学费|学位|补课|双减/.test(s)) return '教育'
			// 「职场」只认打工人视角的词。离职/裁员/工资 这类公司事件词归财经 ——
			// 否则「英伟达财报…黄仁勋离职」会被预填成职场文（实测踩到）。
			if (/职场|上班|加班|求职|跳槽|副业|时间管理|面试|简历|升职|裸辞|内卷|绩效|通勤/.test(s)) return '职场'

			// ② 再判主题型赛道
			if (/明星|综艺|演员|歌手|影视|剧|动漫|搞笑|段子|粉丝|网红|直播|塌房|绯闻|官宣|演唱会|票房|娱乐圈|偶像|选秀|影帝|影后|片酬|代言/.test(s)) return '娱乐'
			if (/AI|大模型|芯片|算法|机器人|算力|开源|编程|开发者|数码|手机|电脑|科学|航天|量子|诺贝尔/.test(s)) return 'AI 与科技'
			if (/美国|日本|俄罗斯|俄|乌克兰|外交|联合国|欧洲|中东|总统|以色列|伊朗|朝鲜|军事|军演|俄乌|加沙|对华|特朗普|普京|欧盟|北约|停火|也门/.test(s)) return '国际与时事'
			if (/股|基金|房价|楼市|财报|营收|融资|上市|消费|税率|工资|经济|商业|创业|公司|企业|汽车|新能源车/.test(s)) return '财经与商业'
			if (/文化|历史|文物|博物馆|古籍|诗|书|电影|展览|美食|菜|旅游|景区|摄影|生活|家居|宠物|非遗/.test(s)) return '文化与生活'

			// ③ 最后是宽口径的兜底：人生感悟 → 社会民生
			if (/人生|感悟|中年|释怀|遗憾|后悔|命运|活着|意义|珍惜|放下|成长|随笔|杂谈|岁月|老去|平凡|和解|通透/.test(s)) return '人生感悟'
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
			'   · 5 个候选标题，**每个标明用的是哪条公式**（见下方「标题 10 条公式」）',
			'     ——不是按「数字/对比/原话/悬念」这种风格形容词写，那只是换措辞；',
			'     要按公式的**结构**写：熟悉事+意外结果 / 普通人+不寻常结果 / 一句干脆的判断……',
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
			'## 标题 10 条公式（**必读，标题按这个写**）',
			'',
			'来源：拆解 1 万篇 10W+ 文章的归纳。**10 条全部可用**，按素材特征选最贴合的 5 条。',
			'分类维度不是修辞手法，是**读者能拿走什么**：',
			'',
			'| # | 公式 | 读者拿走 | 结构要求 |',
			'|---|---|---|---|',
			'| 01 | 场景 + 现成话术 | 能直接说的话 | 前半句钉死那个场景，后半句给能说出口的话 |',
			'| 02 | 数字 + 能拿走的东西 | 一份现成清单 | 开头就给数字，让人知道进来能挑 |',
			'| 03 | 熟悉事 + 意外结果 | 一个答案 | 前半句立「大家以为的」，后半句甩反常结果，**答案不说完** |',
			'| 04 | 折磨人的小动作 + 说到心里的话 | 「对，我也这样」 | 写具体动作，**不要写「内耗」** |',
			'| 05 | 羡慕状态 + 共同点 | 别人怎么做的 | 前半句立让人羡慕的状态，后半句「都有一个共性」 |',
			'| 06 | 熟悉物 + 没想过的问题 | 一个答案 | 问一个有点好笑又真把人问住的问题 |',
			'| 07 | 普通人 + 不寻常结果 + 过程 | 过程细节 | 前半句给人+不寻常结果（带数字），「怎么做到的」留白 |',
			'| 08 | 小钱 + 久困的麻烦 + 办法 | 一个解法 | 先点具体麻烦，再说几块钱解决了 |',
			'| 09 | 快到的日子 + 马上要用的东西 | 现成素材 | 日子写在前面，后面说要用的东西 |',
			'| 10 | 大家都关心的事 + 一句干脆的判断 | 一个立场 | 一句话把立场说死，但**必须跟一个具体例子** |',
			'',
			'### ⚠️ 每条公式的**适用判据**（先判素材，再选公式）',
			'',
			'**这一步最容易错。** 公式名只是标签，套错标签的标题看着像那么回事，其实拿不走东西。',
			'选公式前先问：这条素材**到底能给出什么**？对不上就别用那条公式。',
			'',
			'| # | 只有素材满足这个条件才能用 | 典型错用 |',
			'|---|---|---|',
			'| 01 | 素材里有**可以直接复述的原话/应对句**（怎么回、怎么说、怎么拒绝） | 只给场景不给话术——读者拿不走东西 |',
			'| 02 | 素材本身**能数出来**（3 个动作 / 5 个方法 / 10 条清单） | 数字是时间/尺寸（「10 秒」「45 度」）不算清单，那是 03/06 |',
			'| 03 | 素材存在**「大家以为A、实际B」的反差**，且 B 是需要解释的 | 没有反差硬造——读者不觉得意外 |',
			'| 04 | 素材是**心理/行为上的自我折磨**（反复复盘、忍不住看手机） | **身体自测/健康检查不属于这条**，那是 03 或 06 |',
			'| 05 | 素材里有**一群做得好的人**，能归纳出行为差异 | 只有单个成功者——那是 07 |',
			'| 06 | 素材是**天天用的东西/随口说的话**，从没人认真问过 | 问题是「怎么办」而不是「为什么/是什么」——那是 02 |',
			'| 07 | 素材里有**具体某个人**做成了不寻常的事，且过程有细节 | 没有人、只有现象——那是 03 |',
			'| 08 | 素材是**花钱买了个便宜东西**解决了麻烦 | **自测方法、免费技巧不属于这条**，那是 02 或 06 |',
			'| 09 | 素材对应**明确的日历节点**（节日/开学/年终/月初） | 没有时间锚硬套——读者不觉得急 |',
			'| 10 | 作者对这件事**有明确立场**，且能举出具体例子 | 只有立场没有例子——变成空喊口号 |',
			'',
			'**判据的两个易混点（实测反复出错，这里说清楚）**：',
			'',
			'- **数量词 ≠ 清单**。02 要的是「读者能照着做的 N 条」（3 个动作 / 5 个方法），',
			'  不是「三国元首」「四个信号」这种**数量修饰**。后者数得出来但拿不走，',
			'  按 02 写会变成通稿。',
			'- **状态描述 ≠ 判断**。10 要的是能被反驳的立场（「谈崩的成本更大」），',
			'  不是「终于愿意知道对方底线」这种**描述现状**。后者谁都不会反对，也就没人想点。',
			'',
			'### ⚠️ 5 条候选必须**角度不同**，不是同一件事换措辞',
			'',
			'反例（实测踩过）：素材是「血管堵塞信号」，5 条候选全在讲「怎么自测」，',
			'只是换了「两个动作 / 对镜子笑 / 平举双臂 / 抬腿」——这是**同一个角度换 5 种说法**，不是 5 个候选。',
			'',
			'要求：5 条里至少覆盖 **3 种不同的读者收益**——',
			'有的给方法（怎么测）、有的给认知（为什么会这样）、有的给判断（该不该担心）、有的给场景共鸣（我也这样）。',
			'',
			'### 选首选：按这个评分，不要按输出顺序',
			'',
			'给 5 条各打 0-10 分，**选最高分当 `title`**（首选）：',
			'- 公式用得对（真符合那条公式的适用判据）：**+4**',
			'- 有具体数字或具体动作：**+3**',
			'- 前 12 字里就有钩子（手机列表只显示这么宽）：**+2**',
			'- 无硬禁问题：**+1**',
			'',
			'**「具体数字或动作」这一项不算数的情况**（实测被刷过分，说清楚）：',
			'- 数字是**数量修饰**而不是数据（「三国元首」「四个信号」「三个国家」）——这是泛指，不 +3',
			'- 引号里的内容**不带矛盾**（「管控分歧」是官方话术，本身没有反差）——光有引号不 +3',
			'  真正加分的引语是自带冲突的：「部分批次」「很少生气」这种一听就有问题的',
			'',
			'同分时优先选**读者能拿走东西最多**的那条。',
			'',
			'**硬禁（命中就重写）**：',
			'- ❌ 抽象词收尾：「本质」「格局」「心态」「认知」「逻辑」「意义」「价值」「算过账」「是感动」',
			'  —— 读者看完等于没看，换成具体的人/事/动作',
			'- ❌ 结论式「不是X，是Y」——把答案说了，读者不需要点进去',
			'- ❌ 纯抽象主语（「可读性差不是…」「认知决定…」）——没有具体的人或事',
			'- ❌ 三个以上并列事实——顿号堆砌，没有一个「人」',
			'- ❌ 空问句「为什么XX」——后面必须跟具体对象',
			'- ❌ 抽象隐喻（「背后是两个不同的大脑」）——让人猜，而好标题不需要猜',
			'- ❌ **元叙述**：标题在**评价自己的内容**，而不是直接给内容。',
			'  典型：「这四个字值得看清」「这事别不当回事」「这句话值得一说」「值得每个人想想」。',
			'  这和上面「结论式」是同一类毛病的两面——结论式把答案说完了，元叙述则是**只吆喝不给货**。',
			'  改法：把「值得看清」的那四个字直接摆出来，让读者自己判断值不值得看。',
			'  例：❌「外交部写的是管控分歧，这四个字值得看清」',
			'      ✅「外交部说『管控分歧』，可分歧到底在哪」',
			'',
			'**每条标题输出时带上 formula 字段**（如 "03"）和 formula_name（如 "熟悉事+意外结果"）。',
			'',
			'## 输出格式（严格按这个 JSON，不要加解释文字）',
			'',
			'```json',
			'{',
			'  "material": {',
			'    "source_key": "原样带回素材 key",',
			'    "platform": "原样带回平台",',
			'    "url": "原样带回原文链接，没有就空串",',
			'    "title": "原样带回标题",',
			'    "facts": ["事实1", "事实2"],',
			'    "missing": ["缺口1"],',
			'    "themes": ["命题1", "命题2"]',
			'  },',
			'  "topics": [',
			'    {',
			'      "title": "首选标题（5 个里评分最高的那条）",',
			'      "viewpoint": "作者观点：一句判断句，能被反驳、指向动作或立场",',
			'      "angle": "切入角度：从谁的视角或哪个场景进入",',
			'      "titles": [',
			'        {"title": "候选1", "formula": "03", "formula_name": "熟悉事+意外结果"},',
			'        {"title": "候选2", "formula": "07", "formula_name": "普通人+不寻常结果+过程"},',
			'        {"title": "候选3", "formula": "06", "formula_name": "熟悉物+没想过的问题"},',
			'        {"title": "候选4", "formula": "10", "formula_name": "一句干脆的判断"},',
			'        {"title": "候选5", "formula": "02", "formula_name": "数字+能拿走的东西"}',
			'      ],',
			'      "public_theme": "这条触达的公共命题",',
			'      "direction": "共情 / 拆解 / 反差 / 代价 / 时间 / 旁观",',
			'      "reader_why_click": "读者内心独白",',
			'      "reader_what_get": "读完理解了什么",',
			'      "reader_why_share": "转发时他会说什么",',
			'      "digest": "摘要，能独立成立",',
			'      "outline": [{"heading": "开头", "words": 250, "gist": "..."}],',
			'      "word_count": 1800,',
			'      "scores": {"emotion": 4, "difference": 3, "audience": 4, "window": 2}',
			'    }',
			'  ]',
			'}',
			'```',
			'',
			'**titles 必须是 5 条**，每条带 formula 和 formula_name。少给或只给 3 条都算没按格式做。',
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
			'                **B 类跳过**该配额（娱乐与情感 / AI 与科技 / 教育 / 职场）。',
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
		function dailyTopicPrompt(dateStr, tracks, count) {
			const sub = String(tracks || '').trim()
			const n = Math.max(1, Math.min(10, parseInt(count, 10) || 1))
			const args = ['--date ' + dateStr, '--count ' + n]
			// 赛道只在订阅了才传 —— 不传就是全赛道都看
			if (sub) args.push('--tracks "' + sub + '"')
			return [
				'[工作台自动触发] 生成今日选题 · 每日批量。',
				'',
				'1) 先跑 `python dsh-workbench/tools/topic-pipeline.py ' + args.join(' ') + '`',
				'   ' + (sub
					? '**只在订阅赛道「' + sub + '」里挑**，按标题关键词归类后筛选。'
					: '不限赛道。'),
				'   它会挑 ' + n + ' 条最值得写的素材（多平台共振 > 榜位 > 标题信息量），'
					+ '各写一份加工指令到 `_tmp/topic-prompts/`。',
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
				'· **标题按 10 条爆款公式写**（指令里有完整表格），每条标题标明用的是哪一条。',
				'  硬禁：抽象词收尾（本质/格局/心态/算过账）、「不是X是Y」结论式、三个以上并列、空问句。',
				'· 不及格（情绪<3 且 受众<3）的选题不要提交。',
				'· 不要顺手建草稿——写作技能由用户在创作配置里手选。'
			].join('\n')
		}

		function analysisPrompt(focus) {
			if (!focus || !focus.id) return ANALYSIS_PROMPT

			// 用户在「生成选题」弹窗里填的东西，必须一路传到底。
			// 以前只有赛道生效，数量只当备注印一行，角度/排除/观点完全没接线。
			const p = (focus.preset || {})
			const per = Math.max(1, Math.min(6, parseInt(p.count, 10) || 2))
			const extra = []

			extra.push('【本轮指定】用户刚点的是 job #' + focus.id + '《' + (focus.title || '') + '》。')
			extra.push('请先跑 `topic-pipeline.py --job ' + focus.id +
				' --per ' + per + '` 拿到加工指令，优先完成这一条。')
			extra.push('**这条素材出 ' + per + ' 个选题**（用户指定的数量，不要多也不要少）。')

			if (p.angle) {
				extra.push('用户填的角度倾向（选题必须落在这个范围里）：' + p.angle)
			}
			if (p.viewpoint) {
				extra.push('用户填的个人观点（选题的立场必须从这句话长出来）：' + p.viewpoint)
			}
			if (p.exclude) {
				extra.push('用户填的排除项（一律不许出现）：' + p.exclude)
			}

			extra.push('若还有余量（本次上限 2 条素材），再按 id 倒序取其它 pending。')

			return ANALYSIS_PROMPT + '\n\n' + extra.join('\n')
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
			// ⑧ 标题复核（2026-11-18 加）
			//
			// 为什么必须在写完之后再做一次：选题阶段定标题时**正文还不存在**，
			// 标题只能基于「素材 + 预判的角度」。而 ③定论点 是 Agent 自己定的，
			// 跟选题时的预判可能不是一回事 —— 于是出现「标题说A、正文写B」。
			//
			// **只出候选，不覆盖原标题**：标题是主观判断，机器不该替用户决定。
			// 但「拿正文里最抓人的那句原话当标题」往往比选题时猜的准，
			// 所以候选要优先从正文里找，而不是凭空再造。
			{ k: 'retitle', name: '⑧ 标题复核', need: '⑦落盘的全文 + 当前标题',
			  do: '**先判断，再决定要不要重出。**\n'
			      + '1) 对照检查两项，任一不通过就要重出：\n'
			      + '   · **贴题**：标题承诺的东西，正文真的给了吗？正文的主论点跟标题说的是同一件事吗？\n'
			      + '   · **结构**：符合 10 条爆款公式之一吗？有没有踩硬禁——抽象词收尾（本质/格局/心态/算过账/是感动）、'
			      + '「不是X，是Y」结论式、三个以上并列短语、空问句、抽象隐喻（「是两个不同的大脑」）？\n'
			      + '2) 不通过就按 10 条公式重出 **3 个候选**，写进 `titles_json` 的 `retitle` 字段。\n'
			      + '   **优先从正文里找**：正文里最反常的那句话、最具体的那句原话，往往直接就是好标题。\n'
			      + '3) **不要覆盖 `drafts.title`** —— 让用户在界面上选。只有用户明确说「用第2个」才改。\n'
			      + '4) 通过就把结论写清楚：「标题贴题、结构合规」，不要为了显得干了活而硬改。' },
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
				// 骨架确认开关（设置页「骨架要人工确认」）。
				// 默认关 —— 用户要的是「一次做完」：②③④ 自己定，一路写到交付，不中途停。
				// 开的时候才逐段汇报、骨架后等确认。
				//
				// 2026-11-16 之前这两条是写死的「必须先给用户看、等确认」，
				// 于是每推进一个阶段都要人盯一次，整条流程被切碎。
				const needConfirm = cfgBool('confirmSkeleton', false)

				const exec = needConfirm
					? '**执行要求**：\n' +
					  '1. 不要一口气吐全文。第②③④步的产物要先给用户看。\n' +
					  '2. 第④步给出骨架后，等用户确认再写正文（用户已填骨架则直接沿用）。\n' +
					  '3. 第②步发现素材不足时，**列缺口**，不许用「据了解」「有分析指出」这类话补空。\n' +
					  '4. 第⑥步自检不通过就改，改完再交。\n\n'
					: '**执行要求（连续创作模式）**：\n' +
					  '1. **不要中途停下等确认。** ②③④ 自己定，直接走到 ⑤ 写正文、⑥ 自检、⑦ 交付、⑧ 标题复核。\n' +
					  '2. ②③④ 的产物不必逐段汇报，可以内部完成；但**素材事实和缺口必须在最终回报里列出来**。\n' +
					  '3. 骨架由你自己定，不要问用户要骨架。\n' +
					  '4. 第②步发现素材不足时，**列缺口**，不许用「据了解」「有分析指出」这类话补空。\n' +
					  '5. 第⑥步自检不通过就自己改，改完再交，不要停下来问。\n'
				  + '6. 第⑧步只在标题**不贴题或不合结构**时才重出候选；通过就如实说「合规」，不要硬改。\n\n'

				return '【创作骨架 · 必须逐阶段走完，不许跳步】\n' +
					'以下八步是本项目的固定流程，优先级高于任何 SKILL.md 里自带的步骤划分。\n' +
					'技能只负责第⑤步的写法，不负责流程。\n\n' + lines.join('\n\n') +
					'\n\n' + exec +
				headingRulesText()
			}
			return lines.join('\n\n')
		}

		function writingPrompt(focus) {
			if (!focus || !focus.id) return WRITING_PROMPT
			let t = WRITING_PROMPT + '\n\n【本轮指定】draft #' + focus.id + '《' + (focus.title || '') + '》'
			// 推进范围由「骨架要人工确认」开关决定：
			//   关（默认）= 一次跑到底，一直做到 formatted（图位插好）再停
			//   开 = 只推进一个阶段，每步等人确认
			//
			// 为什么停在 formatted：按项目规则，配图和发布必须是用户手工发起，
			// 自动流程的终点就是「图位插好、可以配图了」。
			const stepwise = cfgBool('confirmSkeleton', false)
			if (focus.from) {
				t += '，当前阶段 ' + (DRAFT_LABEL[focus.from] || focus.from)
				if (stepwise) {
					t += '，请推进到下一阶段' +
						(nextStage(focus.from) ? '（' + DRAFT_LABEL[nextStage(focus.from)] + '）' : '')
				} else {
					t += '。**连续执行，不要逐阶段停下等确认**：' +
						'从当前阶段一路做到「已排版」（formatted，图位插好）为止，' +
						'中间每一阶段用 set-draft 回写 status 和产出字段。' +
						'**做到 formatted 就停**——配图和发布由用户手工发起，不要往下走。' +
						'硬闸门（符号/事实/结构/论点）不过就停下改，改完继续。'
				}
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
					// 署名禁令（2026-11-19 加）
					//
					// 实测事故：定时任务用 khazix-writer 写稿，正文末尾出现了
					// `> / 作者：卡兹克` —— 那是 SKILL.md 里的文章模板，
					// Agent 照着抄了一遍。
					//
					// 这是**身份错误**，不是格式问题：我们借的是这个技能的写法，
					// 不是要冒充卡兹克本人。作者署名必须由账号自己决定，
					// 不能从技能文档里继承。
					//
					// 放在这里而不是改 SKILL.md：那是第三方技能文件，
					// 改了下次更新会被覆盖，而且别的项目可能真的需要署名。
					'- ⛔ **正文里绝对不能出现原作者署名**。技能文档里的 `> / 作者：卡兹克` ' +
					'那样的模板**不要抄**。你借的是它的写法，不是冒充它本人。' +
					'正文结尾直接结束，不加作者、不加署名行、不加「本文作者」之类的落款。\n\n' +
					'--- 风格正文开始 ---\n' + focus.styleBody + '\n--- 风格正文结束 ---'
			}
			return t
		}

		// 投递目标的默认规则是「最近活跃的会话」。
		// 早先这里有个 TARGET_SESSION_TITLE='Agent-公众号'，想在用户没配的时候
		// 按标题锚定专用会话 —— 但标题匹配从来没生效过（见 sessionTitle 注释），
		// 而且用户要的规则本来就是「没配就用最近活跃的」。猜标题是多余的一层，
		// 猜错了会把指令投到用户没预期的会话上，所以整个去掉。

		/**
		 * 从会话对象里取标题。
		 *
		 * 2026-11-17 修：`session.list` 返回的每一项里**没有顶层 title**，
		 * 标题在 `projections.values.title`（wire schema 见
		 * dsh-api-session-controller/lib/typert.remote-client.js:785）。
		 * 老代码只读 `s.title`，永远拿到空串，于是：
		 *   ① 精确匹配必然失败 → ② 包含匹配必然失败 → ③ 必然「退回最近更新」。
		 * 这就是用户抱怨「以最近聊过的会话触发、范围是整个 DSH」的真正原因 ——
		 * 不是没写匹配逻辑，是匹配逻辑从来没生效过。
		 * 顶层字段也留着兜底：不同版本/不同来源可能把它平铺出来。
		 */
		function sessionTitle(s) {
			if (!s) return ''
			const flat = s.title || s.name || s.label || s.subject
			if (flat) return String(flat).trim()
			const pv = s.projections && s.projections.values
			if (pv && pv.title) return String(pv.title).trim()
			return ''
		}

		/** 会话是否正在跑。字段名各家不一，全都试一遍，认不出就当没在跑。 */
		function sessionBusy(s) {
			if (!s) return false
			const v = s.running ?? s.busy ?? s.streaming ?? s.inFlight ?? s.active
			if (v === true) return true
			const st = String(s.status || s.state || '').toLowerCase()
			return st === 'running' || st === 'streaming' || st === 'busy' || st === 'working'
		}

		/**
		 * 解析「这次指令到底投给哪个会话」。
		 *
		 * 规则（2026-11-17 按用户需求定稿）：
		 *   ① 设置面板里配了指定会话 → 就用它
		 *   ② 没配 → 用最近活跃的会话（兜底，不硬失败）
		 *
		 * 注意这里**不再按标题猜**。老代码有个 TARGET_SESSION_TITLE='Agent-公众号'，
		 * 想在没配的时候按标题找那个会话，但那个匹配从来没生效过（见 sessionTitle 的注释），
		 * 而用户真正要的规则本来就是「没配就用最近活跃的」—— 猜标题是多余的一层，
		 * 猜错了还会把指令投到一个用户没预期的会话上。所以直接去掉。
		 */
		function resolveTargetSession(items, wantId) {
			const list = (items || []).filter((s) => s && s.origin !== 'subagent' && s.blank !== true)
			const id = String(wantId || '').trim()
			// ① 用户配了就用配的（配的会话被删了就落到 ②）
			if (id) {
				const hit = list.find((s) => String(s.sessionId) === id)
				if (hit) {
					return { target: hit, how: '设置里指定的会话', title: sessionTitle(hit) || String(hit.sessionId).slice(0, 8) }
				}
			}
			// ② 没配（或配的已失效）→ 最近活跃
			const sorted = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
			const newest = sorted[0] || null
			if (!newest) return null
			return {
				target: newest,
				how: id ? '设置的会话已不存在，改用最近活跃' : '最近活跃会话',
				title: sessionTitle(newest) || String(newest.sessionId).slice(0, 8)
			}
		}

		/**
		 * 算出「用户配置的会话 ID」。没配返回空串 —— 空 = 走最近活跃。
		 * preferredTitle 保留形参是为了兼容老调用点，现在不再按标题找。
		 */
		function resolveTargetWish(preferredTitle) {
			let wantId = ''
			try {
				const cfgId = cfgStr('targetSessionId', '')
				if (cfgId) wantId = cfgId
			} catch (err) { /* 设置没读到就往下走 */ }
			if (!wantId && preferredTitle) {
				// 老调用点可能传了标题：当作一次精确标题匹配的补充，
				// 匹配不上就当没配（走最近活跃），绝不猜。
				return { wantId: '', want: String(preferredTitle).trim() }
			}
			return { wantId: wantId, want: '' }
		}

		async function triggerAgent(remote, log, text, preferredTitle) {
			if (!remote || !remote.session || typeof remote.session.list !== 'function') {
				throw new Error('remote.session 不可用')
			}
			const listed = await remote.session.list({})
			if (listed && listed.ok === false) {
				throw new Error('session.list 失败：' + JSON.stringify(listed.error))
			}
			const items = ((listed && listed.value && listed.value.items) || [])
				.filter((s) => s && s.origin !== 'subagent' && s.blank !== true)

			const wish = resolveTargetWish(preferredTitle)
			// preferredTitle 精确命中（仅老调用点会走到）
			let got = null
			if (!wish.wantId && wish.want) {
				const hit = items.find((s) => sessionTitle(s) === wish.want)
				if (hit) got = { target: hit, how: '调用方指定', title: sessionTitle(hit) || String(hit.sessionId).slice(0, 8) }
			}
			if (!got) got = resolveTargetSession(items, wish.wantId)
			if (!got) throw new Error('找不到可用会话')
			const target = got.target
			const how = got.how
			if (log) log('投递目标：' + got.title + '　（' + how + '）')

			// 冷却只在「目标会话确实在跑」时才生效。
			// 用户手工停止后，会话不再 running，此时不该拦——那一轮已经结束了。
			const busy = sessionBusy(target)
			if (busy && Date.now() - lastTriggerAt < TRIGGER_COOLDOWN_MS) {
				const left = Math.ceil((TRIGGER_COOLDOWN_MS - (Date.now() - lastTriggerAt)) / 1000)
				throw new Error('COOLDOWN:' + left)
			}

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

		// 二级菜单的**分组**（2026-11-17 优化）。
		//
		// 原来 8 个 tab 一条平铺：找灵感(热榜/爆文库/选题库) · 创作 · 管内容(我的创作/发布管理)
		// · 配资源(风格库/技能包) —— 四类东西混在一行，越加越多就没地方放了。
		// 现在按「用户要干什么」收成 4 个主 Tab，其中两组带下拉子项。
		//
		// **两件不能省的事**：
		//   · `modules` 仍然是平铺的页面清单 —— 它是「有哪些页面」的唯一事实来源，
		//     下面渲染 view / 判断 mod 全靠它。菜单只是它的**展示分层**，不是第二份页面定义。
		//   · 子项仍然是可以直接 setMod 的独立页面，所以「我的创作」「发布管理」
		//     没被真的合并 —— 深链接、记忆位置、以前的用法全都不失效。
		const MENU = {
			gzh: [
				// 创作台排第一：它是这个工作台的主线动作（写稿），
				// 找灵感是它的**前置**，但用户进来十次有八次是想接着写。
				{ label: '创作台', items: ['创作台'] },
				{ label: '找灵感', items: ['每日热榜', '爆文库', '选题库'] },
				{ label: '内容管理', items: ['我的创作', '发布管理'] },
				{ label: '资源库', items: ['风格库', '技能包'] }
			],
			image: [
				{ label: '漫图创作', items: ['漫图创作'] },
				// 我的创作放第二：出完图最常做的是回头看产出，
				// 资源库（风格/图型/色卡/角色）是「出图前挑素材」，属配置类，排后面。
				{ label: '我的创作', items: ['我的创作'] },
				{ label: '资源库', items: ['风格库', '图型库', '主色调', '角色资产库'] },
				{ label: '技能包', items: ['技能包'] }
				// 注意：**不要在这里加「设置」**。设置是 AppShell 顶部的一级 Tab，
				// 不属于任何子工作台；放进侧边栏会出现两个入口指向同一页。
				// 上一版为了「覆盖全部页面」加过，结果侧边栏多出一条无用项（实测反馈）。
			],
			skills: [{ label: '技能库', items: ['技能库'] }]
		}
		/** 取某个 app 的菜单；没配就退化成平铺（不会因为漏配一个 app 就不显示菜单）。 */
		function menuOf(app) {
			return MENU[app.key] || [{ label: app.label, items: app.modules }]
		}
		/**
		 * 按「模块清单」反推菜单分组。ImageStudio 拿到的是一份 modules 数组
		 * （props.modules），不是 app.key，所以按清单内容匹配一次。
		 * 匹配不上就平铺 —— 菜单是展示层，不能因为它匹配失败就把功能弄没了。
		 */
		function menuForModules(modules) {
			const list = Array.isArray(modules) ? modules : []
			for (const key of Object.keys(MENU)) {
				const groups = MENU[key]
				const flat = groups.reduce((a, g) => a.concat(g.items), [])
				// 用「命中数」而不是完全相等：模块清单可能因为版本差异多一项或少一项，
				// 要求一模一样会让菜单整体退化成平铺（看起来像样式没生效）。
				const hit = list.filter((m) => flat.indexOf(m) >= 0).length
				if (hit >= Math.min(list.length, flat.length) - 1 && hit >= 2) {
					// **兜底：清单里有、分组里没有的页面，追加一个分组挂上去**。
					// 少一个分组就等于把一个入口藏起来，而用户根本不知道去哪找。
					// 以后 MODULES 加一项也不会因为忘记改 MENU 而消失。
					const orphan = list.filter((m) => flat.indexOf(m) < 0)
					if (!orphan.length) return groups
					const out = groups.filter((g) => g.items.some((m) => list.indexOf(m) >= 0))
					out.push({ label: orphan.length === 1 ? orphan[0] : '其他', items: orphan })
					return out
				}
			}
			return [{ label: '全部', items: list }]
		}

		/**
		 * 二级导航（左侧边栏，2026-11-17 从顶部横条改过来）。
		 *
		 * 为什么改：顶部横条横向空间有限，8 个模块 + 下拉已经挤，再加就没地方了；
		 * 侧边栏是竖向的，模块名多长都放得下，还能用「分组小标题」把它们归类，
		 * 一眼看出哪几项是一类（找灵感 / 内容管理 / 资源库）。
		 *
		 * 顶部只留一级 Tab（公众号 / 绘图 / 技能库 / 设置），页面清爽很多。
		 *
		 * @param modules  本应用的模块清单（平铺，是页面来源的唯一事实）
		 * @param cur      当前页面
		 * @param go       切页
		 */
		// 侧边栏图标（线性、单色，跟随 currentColor）。
		// 用内联 SVG 而不是 emoji：emoji 带自己的颜色，在深浅主题下都突兀，
		// 而且不同平台字形差异大。16×16 线条图标和正文色调天然一致。
		const NAV_ICONS = {
			'每日热榜': 'M3 17V9M8 17V4M13 17v-6M18 17h1',           // 柱状图
			'爆文库': 'M4 5h12v10H4zM7 8h6M7 11h4',                    // 文档
			'选题库': 'M9 4a5 5 0 100 10A5 5 0 009 4zM9 7v2M9 11h.01', // 灯泡
			'创作台': 'M4 15l8-8 2 2-8 8H4v-2zM12 5l2 2',              // 笔
			'我的创作': 'M4 4h9l3 3v9H4zM7 9h6M7 12h4',                // 稿件
			'发布管理': 'M4 6h12M4 10h12M4 14h7',                      // 列表
			'风格库': 'M4 9a5 5 0 1010 0A5 5 0 004 9zM9 4v10',         // 调色
			'技能包': 'M4 6h12v8H4zM4 9h12',                           // 工具箱
			'漫图创作': 'M3 5h12v10H3zM3 12l3-3 3 3 2-2 4 4',          // 图片
			'图型库': 'M3 4h12v10H3zM6 7h2M6 10h6',                    // 版式
			'主色调': 'M4 9a5 5 0 1010 0A5 5 0 004 9z',                // 圆
			'角色资产库': 'M9 5a2 2 0 100 4 2 2 0 000-4zM5 15c0-2 2-3 4-3s4 1 4 3', // 人像
			'技能库': 'M4 5h12v10H4zM4 8h12M8 8v7',                    // 书
			'设置': 'M9 7a2 2 0 100 4 2 2 0 000-4zM9 3v2M9 13v2M3 9h2M13 9h2'
		}
		/** 没有专属图标的模块画一个圆点，保证左侧对齐不塌。 */
		function navIcon(name) {
			const d = NAV_ICONS[name]
			if (!d) {
				return h('svg', {
					width: 15, height: 15, viewBox: '0 0 18 18', fill: 'none',
					style: { flex: '0 0 auto', opacity: 0.75 }
				}, h('circle', { cx: 9, cy: 9, r: 2.2, fill: 'currentColor' }))
			}
			return h('svg', {
				width: 15, height: 15, viewBox: '0 0 18 18', fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.5,
				strokeLinecap: 'round', strokeLinejoin: 'round',
				style: { flex: '0 0 auto' }
			}, h('path', { d }))
		}

		/**
		 * 二级导航（左侧边栏）。
		 *
		 * 层级怎么区分（2026-11-17 按参考产品重做，解决「看不出谁是标题谁是项」）：
		 *   · 分组标题：11px、很浅（opacity .5）、字重 600、上方留白 12px 拉开，
		 *     并且**不响应鼠标**（不能点、不出现手型）—— 一眼就知道它是标题。
		 *   · 子项：13px、有图标、行高更高、圆角按钮，右侧留选中竖条的位置。
		 *   · 选中：浅底 + 左侧 3px 竖条 + 加粗，比只换底色更容易一眼定位。
		 * 关键差别是**字号 + 图标 + 高度**三样都不一样，而不是只靠深浅。
		 */
		function renderSideNav(modules, cur, go) {
			const groups = menuForModules(modules)
			// 只有一组（技能库这种单页）就不出分组标题，免得出现「技能库 / 技能库」
			const showGroupTitle = groups.length > 1
			return groups.map((g, gi) => {
				// 分组名和它唯一的子项同名（如「创作台」组里只有「创作台」）：
				// 只渲染一层就够，否则侧边栏会连写两遍一样的字，看着像重复的 bug。
				const sameName = g.items.length === 1 && g.items[0] === g.label
				return h('div', { key: g.label, style: { marginTop: gi === 0 ? 0 : '10px' } },
					showGroupTitle && !sameName
						? h('div', {
							style: {
								// 分组标题：字号更小、更浅、字重 600、全大写间距感，
								// 上方还有一条极浅的横线把组与组切开 ——
								// 这三样加起来才和「13px + 图标 + 圆角按钮」的子项拉开距离。
								display: 'flex', alignItems: 'center', gap: '7px',
								padding: '0 10px 6px',
								fontSize: '11px', fontWeight: 600, letterSpacing: '0.02em',
								opacity: 0.5, whiteSpace: 'nowrap',
								userSelect: 'none', cursor: 'default'
							}
						},
							h('span', null, g.label),
							// 标题右侧拉一条渐隐细线，视觉上把这一组「收起来」
							gi === 0 ? null : h('span', {
								style: {
									flex: '1 1 auto', height: '1px', minWidth: '8px',
									background: 'currentColor', opacity: 0.35
								}
							}))
						: null,
					g.items.map((m) => {
						const on = cur === m
						return h('button', {
							key: m, type: 'button',
							style: {
								position: 'relative',
								display: 'flex', alignItems: 'center', gap: '9px',
								width: '100%', textAlign: 'left',
								padding: '8px 10px', marginBottom: '2px',
								borderRadius: '8px', border: 0, cursor: 'pointer',
								font: 'inherit', fontSize: '13px', whiteSpace: 'nowrap',
								overflow: 'hidden',
								background: on
									? 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)'
									: 'transparent',
								color: on
									? 'var(--dsw-alias-label-primary)'
									: 'var(--dsw-alias-label-secondary)',
								fontWeight: on ? 650 : 400
							},
							onMouseEnter: (ev) => {
								if (on) return
								ev.currentTarget.style.color = 'var(--dsw-alias-label-primary)'
								ev.currentTarget.style.background =
									'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)'
							},
							onMouseLeave: (ev) => {
								if (on) return
								ev.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'
								ev.currentTarget.style.background = 'transparent'
							},
							onClick: () => go(m)
						},
							// 左侧竖条：选中时才出现。绝对定位不占布局，
							// 所以图标和文字的左边框在所有状态下都对齐。
							on
								? h('span', {
									style: {
										position: 'absolute', left: 0, top: '50%',
										transform: 'translateY(-50%)',
										width: '3px', height: '16px', borderRadius: '2px',
										background: 'var(--dsw-alias-label-primary)'
									}
								})
								: null,
							navIcon(m),
							h('span', {
								style: { overflow: 'hidden', textOverflow: 'ellipsis' }
							}, sameName ? g.label : m))
					}))
			})
		}

		/**
		 * 二级菜单渲染（公众号与绘图工作台共用）。
		 *
		 * 抽出这一个函数是因为两边菜单长得一样、规则也一样；各写一遍必然漂移
		 * （改了一边忘了另一边，是这类菜单最常见的事故）。
		 *
		 * @param modules  本应用的模块清单（平铺，是页面来源的唯一事实）
		 * @param cur      当前页面
		 * @param go       切页
		 * @param open     当前展开的组名 / ''
		 * @param setOpen  设置展开的组名
		 */
		function renderModMenu(modules, cur, go, open, setOpen) {
			return menuForModules(modules).map((g) => {
				const inGroup = g.items.indexOf(cur) >= 0
				if (g.items.length === 1) {
					const m = g.items[0]
					return h('button', {
						key: g.label, type: 'button',
						style: Object.assign({}, S.tab, cur === m ? S.tabOn : S.tabOff),
						onClick: () => go(m)
					}, g.label)
				}
				return h('div', {
					key: g.label,
					// 悬停展开：进这块就开、离开就收。
					// 收起要延迟一点点，否则从按钮移到下拉的 4px 间隙里会闪一下关掉。
					onMouseEnter: () => setOpen(g.label),
					onMouseLeave: () => setOpen((c) => (c === g.label ? '' : c)),
					style: { position: 'relative' }
				},
					h('button', {
						type: 'button',
						style: Object.assign({}, S.tab,
							inGroup ? S.tabOn : S.tabOff,
							{ display: 'inline-flex', alignItems: 'center', gap: '5px' }),
						onClick: () => { go(g.items[0]); setOpen('') }
					},
						g.label,
						h('span', { style: { fontSize: '9px', opacity: 0.6 } }, '▾')),
					open === g.label
						? h('div', {
							style: {
								position: 'absolute', top: '100%', left: 0, zIndex: 30,
								// 顶上去一点盖住按钮与下拉之间那几像素，鼠标移过去不会掉出去
								marginTop: '2px', paddingTop: '4px',
								minWidth: '150px'
							}
						},
							h('div', {
								style: {
									padding: '5px', borderRadius: '10px',
									border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)',
									background: 'var(--dsw-alias-bg-layer-1, #fff)',
									boxShadow: '0 12px 32px rgba(0,0,0,0.16)'
								}
							},
								g.items.map((m) => h('button', {
									key: m, type: 'button',
									style: {
										display: 'block', width: '100%', textAlign: 'left',
										padding: '7px 11px', borderRadius: '7px', border: 0,
										cursor: 'pointer', font: 'inherit', fontSize: '12.5px',
										whiteSpace: 'nowrap',
										background: cur === m
											? 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)'
											: 'transparent',
										color: cur === m
											? 'var(--dsw-alias-label-primary)'
											: 'var(--dsw-alias-label-secondary)',
										fontWeight: cur === m ? 650 : 400
									},
									onClick: () => { go(m); setOpen('') }
								}, m))))
						: null)
			})
		}

		// modules 的顺序**只有 [0] 有意义**：它是这个工作台默认打开的页面。
		// 侧边栏的展示顺序由 MENU 决定（见 renderSideNav），不是这个数组 ——
		// 两者分开是有意的：菜单要按「用户要干什么」分组（创作台/找灵感/内容管理/资源库），
		// 而数组是「有哪些页面」的清单，不该被展示顺序捆绑。
		// **改默认页时两处都要动**：MENU 的第一组 + 这里的 [0]。
		const APPS = [
			{ key: 'gzh', label: '公众号', glyph: '公', pack: 'gzh',
			  // 每日热榜和爆文库是**两个平级模块**，不是「素材库」里的两个页签：
			  // 热榜是当天的实时风向（天天变、7 个平台），爆文库是跨平台的存量爆款
			  // （按日期回溯、带封面和互动数）。混在一个页里用户找不到爆文库。
			  // [0] = 创作台：进公众号十次有八次是接着写稿，默认落在它上面。
			  modules: ['创作台', '每日热榜', '爆文库', '选题库', '我的创作', '发布管理', '风格库', '技能包'] },
			// 画廊的四个库**各自是独立模块**，不合并成一个带子切换的页：
			// 它们是四种不同的资产，合并会让人以为只做了第一个（第一版就踩了这个）。
			// 注：角色/道具/场景是「资产库」不是画廊，见下方 ASSET_MOD。
			{ key: 'image', label: '绘图', glyph: '图', pack: 'image',
			  modules: ['漫图创作', '风格库', '图型库', '主色调', '角色资产库', '我的创作', '技能包'] },
			{ key: 'skills', label: '技能库', glyph: '技', kind: 'registry', modules: ['技能库'] }
		]

		// 侧边栏上的那个唯一入口。DSH 的 sidebar.panellist 没有层级概念，
		// 三个子工作台只能靠这一个图标进去，内部再用标签切换。
		const APP_GROUP = { key: 'moyu', label: '墨鱼创作工作台', glyph: '墨', logo: true }

		// ── 侧边栏 LOGO（2026-11-18）──
		//
		// 为什么内联 SVG 字符串，而不是 <img src="...png">：
		//   · 侧边栏图标只有 18–26px，位图缩到这么小会糊；SVG 任意尺寸都锐利
		//   · 插件包里的 media/ 没有可访问的 URL —— 现有 /api/workbench/image-asset
		//     只开放 skill 和 workspace 两个根，读不到包内文件；
		//     为一张图标再开一条路由不值得
		//   · 矢量源码压完才 1.4KB，内联进代码比任何加载方式都简单可靠
		//
		// Plugin Manager 里那张大图标仍用 media/moyu-logo.png（见 package.json 的 ./icon）。
		const MOYU_LOGO_SVG =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
			'<path fill="#1A1A1A" d="M50 12C31 12 16 27 16 46C16 57 20 66 27 72L27 78C27 82 30 85 34 85' +
			'C38 85 41 82 41 78L41 74C44 76 47 77 50 77C53 77 56 76 59 74L59 78C59 82 62 85 66 85' +
			'C70 85 73 82 73 78L73 72C80 66 84 57 84 46C84 27 69 12 50 12Z"/>' +
			'<path fill="#3DBFA0" d="M50 20L57 27L50 34L43 27Z"/>' +
			'<path fill="#3DBFA0" d="M25 30L32 25L34 33L27 38Z"/>' +
			'<path fill="#3DBFA0" d="M75 30L68 25L66 33L73 38Z"/>' +
			'<ellipse cx="30" cy="62" rx="6" ry="4" fill="#F98F72"/>' +
			'<ellipse cx="70" cy="62" rx="6" ry="4" fill="#F98F72"/>' +
			'<ellipse cx="38" cy="50" rx="10" ry="11" fill="#FFFFFF"/>' +
			'<ellipse cx="62" cy="50" rx="10" ry="11" fill="#FFFFFF"/>' +
			'<path fill="#1A1A1A" d="M38 43C35 43 33 46 33 50C33 54 35 57 38 57C41 57 43 54 43 50C43 46 41 43 38 43Z' +
			'M62 43C59 43 57 46 57 50C57 54 59 57 62 57C65 57 67 54 67 50C67 46 65 43 62 43Z"/>' +
			'<ellipse cx="35" cy="47" rx="2.6" ry="3" fill="#FFFFFF"/>' +
			'<ellipse cx="59" cy="47" rx="2.6" ry="3" fill="#FFFFFF"/>' +
			'<path d="M46 62Q50 66 54 62" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round"/>' +
			'</svg>'
		/** 把 SVG 源码转成可直接塞进 img src 的 data URI（避免编码问题用了 encodeURIComponent） */
		const MOYU_LOGO_URI = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(MOYU_LOGO_SVG)

		// ── 右上角那只动的墨鱼（2026-11-18）──
		//
		// 为什么动画走 CSS 而不是 JS 定时器：
		//   · 纯装饰不该占主线程；定时器还会因为组件重渲染被重置，动画会抽
		//   · 项目里已有 @keyframes 先例（创作进度条的 dswWbPulse）
		//
		// 为什么触手要**各自动**、周期还错开：
		//   五条同步摆像机械臂，错开后才有活物感。这是原型阶段实测出来的，
		//   不是随手写的随机数 —— 2.2/2.6/3.0/2.4/2.8 秒，相邻两条至少差 0.2 秒。
		//
		// 部件必须**分层**：侧边栏那份 SVG 是扁平单路径，触手连成一片，动不了。
		// 所以这里单独一套：5 条触手 + 头部 + 眼睛各成一层。
		const MOYU_ANIM_CSS = `
@keyframes dswMoyuBob {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2px); }
}
@keyframes dswMoyuNod {
  0%, 100% { transform: rotate(-3deg) scale(1.06); }
  50%      { transform: rotate(3deg) scale(1.06); }
}
@keyframes dswMoyuSway {
  0%, 100% { transform: rotate(-4deg); }
  50%      { transform: rotate(4deg); }
}
@keyframes dswMoyuBlink {
  0%, 92%, 100% { transform: scaleY(1); }
  95%           { transform: scaleY(.08); }
}
.dsw-moyu {
  display: inline-block; cursor: pointer; transform-origin: 50% 100%;
  animation: dswMoyuBob 4s ease-in-out infinite;
}
.dsw-moyu:hover { animation: dswMoyuNod .9s ease-in-out infinite; }
.dsw-moyu .tn { transform-origin: 50% 0%; animation: dswMoyuSway 2.2s ease-in-out infinite; }
.dsw-moyu .tn2 { animation-duration: 2.6s; animation-delay: -.5s; }
.dsw-moyu .tn3 { animation-duration: 3s;   animation-delay: -1.1s; }
.dsw-moyu .tn4 { animation-duration: 2.4s; animation-delay: -.8s; }
.dsw-moyu .tn5 { animation-duration: 2.8s; animation-delay: -.3s; }
.dsw-moyu .eyelid { animation: dswMoyuBlink 6s infinite; transform-box: fill-box; }

/* ── 跳舞：进度条上「进行中」时用 ──
   整只左右扭 + 上下颠。两段动画叠加在同一个元素上做不到（animation 会互相覆盖），
   所以扭用外层、颠用 translateY 合进同一个 keyframes 里。 */
@keyframes dswMoyuDance {
  0%   { transform: translateY(0)     rotate(-7deg) scale(1); }
  25%  { transform: translateY(-3px)  rotate(0deg)  scale(1.04); }
  50%  { transform: translateY(0)     rotate(7deg)  scale(1); }
  75%  { transform: translateY(-3px)  rotate(0deg)  scale(1.04); }
  100% { transform: translateY(0)     rotate(-7deg) scale(1); }
}
.dsw-moyu-dance { animation: dswMoyuDance 1.15s ease-in-out infinite; transform-origin: 50% 100%; }
/* 跳舞时触手摆得更快、幅度更大，跟着节奏走 */
.dsw-moyu-dance .tn  { animation-duration: .9s; }
.dsw-moyu-dance .tn2 { animation-duration: 1.1s; }
.dsw-moyu-dance .tn3 { animation-duration: 1s; }
.dsw-moyu-dance .tn4 { animation-duration: 1.2s; }
.dsw-moyu-dance .tn5 { animation-duration: .95s; }
@keyframes dswMoyuSwayFast {
  0%, 100% { transform: rotate(-11deg); }
  50%      { transform: rotate(11deg); }
}
.dsw-moyu-dance .tn { animation-name: dswMoyuSwayFast; }
/* 疑似卡住：完全静止（连触手都不摆）—— 动了会让人误以为还在跑 */
.dsw-moyu-stale, .dsw-moyu-stale .tn, .dsw-moyu-stale .eyelid { animation: none !important; }

/* 系统开了「减少动态效果」就不动 —— 这类动画对前庭敏感人群是干扰 */
@media (prefers-reduced-motion: reduce) {
  .dsw-moyu, .dsw-moyu:hover, .dsw-moyu-dance,
  .dsw-moyu .tn, .dsw-moyu .eyelid { animation: none !important; }
}
`

		// ── 墨鱼的表情集 ──
		//
		// 形象沿用原 LOGO（黑色圆头 + 三个青菱形 + 粉腮红 + 触手），
		// **只换眼睛和嘴**。表情风格参考用户提供的那套 Q 版表情图，
		// 但整套 16 个没有全做 —— 进度条上只需要能表达「在干什么」的几个。
		//
		// 挑这 5 个的理由，按进度百分比切换：
		//   focused  专注   0%–35%   眼睛盯住、嘴抿成一条线 —— 刚开始干活
		//   happy    开心   35%–65%  弯眼笑 ------------------- 进展顺利
		//   star     得意   65%–99%  星星眼 ------------------- 快好了
		//   cheer    撒花   100%     闭眼笑 + 两侧小彩点 -------- 完成
		//   sleep    趴着   stale    闭眼 + zzz --------------- 卡住了
		//
		// 每个表情只描述「眼睛 + 嘴 + 附加装饰」，头部/菱形/腮红/触手共用一份 ——
		// 这样加一个表情只要写几行，不会改到形象本身。
		function moyuFace(kind) {
			const W = '#FFFFFF'
			const eye = (cx, inner) => h('g', { className: 'eyelid',
				style: { transformOrigin: cx + 'px 50px' } }, inner)
			// 圆眼（默认）：白底 + 黑瞳 + 高光
			const roundEye = (cx) => [
				h('ellipse', { cx, cy: 50, rx: 10, ry: 11, fill: W }),
				h('path', { fill: '#1A1A1A', d: `M${cx} 43C${cx - 3} 43 ${cx - 5} 46 ${cx - 5} 50` +
					`C${cx - 5} 54 ${cx - 3} 57 ${cx} 57C${cx + 3} 57 ${cx + 5} 54 ${cx + 5} 50` +
					`C${cx + 5} 46 ${cx + 3} 43 ${cx} 43Z` }),
				h('ellipse', { cx: cx - 3, cy: 47, rx: 2.6, ry: 3, fill: W }),
			]
			// 弯眼笑（^ ^ 形状，用描边弧线）
			const arcEye = (cx) => h('path', {
				d: `M${cx - 9} 53Q${cx} 42 ${cx + 9} 53`,
				stroke: W, strokeWidth: 3.4, fill: 'none', strokeLinecap: 'round'
			})
			// 星星眼：四角星
			const starEye = (cx) => h('path', {
				fill: W,
				d: `M${cx} 39L${cx + 3.2} 47.2L${cx + 11} 50L${cx + 3.2} 52.8` +
					`L${cx} 61L${cx - 3.2} 52.8L${cx - 11} 50L${cx - 3.2} 47.2Z`
			})

			if (kind === 'happy') {
				return {
					eyes: h('g', null, arcEye(38), arcEye(62)),
					mouth: h('path', { d: 'M45 61Q50 68 55 61', stroke: W, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' }),
				}
			}
			if (kind === 'star') {
				return {
					eyes: h('g', null, starEye(38), starEye(62)),
					mouth: h('path', { d: 'M45 61Q50 68 55 61', stroke: W, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' }),
					extra: h('g', { fill: '#3DBFA0' },
						h('path', { d: 'M88 22L90 27L95 29L90 31L88 36L86 31L81 29L86 27Z' }),
						h('path', { d: 'M12 24L13.6 28L18 29.6L13.6 31.2L12 35L10.4 31.2L6 29.6L10.4 28Z' })),
				}
			}
			if (kind === 'cheer') {
				return {
					eyes: h('g', null, arcEye(38), arcEye(62)),
					mouth: h('path', { d: 'M44 60Q50 70 56 60', stroke: W, strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' }),
					// 撒花：两侧各三颗小点，颜色和菱形呼应
					extra: h('g', null,
						h('circle', { cx: 8, cy: 30, r: 2.4, fill: '#3DBFA0' }),
						h('circle', { cx: 14, cy: 40, r: 1.8, fill: '#F98F72' }),
						h('circle', { cx: 6, cy: 44, r: 1.6, fill: '#3DBFA0' }),
						h('circle', { cx: 92, cy: 30, r: 2.4, fill: '#F98F72' }),
						h('circle', { cx: 86, cy: 40, r: 1.8, fill: '#3DBFA0' }),
						h('circle', { cx: 94, cy: 44, r: 1.6, fill: '#F98F72' })),
				}
			}
			if (kind === 'sleep') {
				return {
					eyes: h('g', null,
						h('path', { d: 'M29 50Q38 58 47 50', stroke: W, strokeWidth: 2.6, fill: 'none', strokeLinecap: 'round' }),
						h('path', { d: 'M53 50Q62 58 71 50', stroke: W, strokeWidth: 2.6, fill: 'none', strokeLinecap: 'round' })),
					mouth: h('path', { d: 'M48 63h4', stroke: W, strokeWidth: 2, strokeLinecap: 'round' }),
					// zzz
					extra: h('text', {
						x: 86, y: 26, fill: '#3DBFA0', fontSize: 15, fontWeight: 700,
						fontFamily: 'ui-rounded, system-ui, sans-serif'
					}, 'z'),
				}
			}
			// focused（默认）：圆眼盯住 + 抿嘴
			return {
				eyes: h('g', null,
					eye(38, roundEye(38)),
					eye(62, h('g', { style: { animationDelay: '.04s' } }, roundEye(62)))),
				mouth: h('path', { d: 'M46 63h8', stroke: W, strokeWidth: 2, strokeLinecap: 'round' }),
			}
		}

		/** 墨鱼形象：会呼吸、触手会摆、按 mood 换表情。 */
		function MoyuMascot(props) {
			const size = (props && props.size) || 40
			const dance = !!(props && props.dance)
			const stale = !!(props && props.stale)
			const mood = (props && props.mood) || (stale ? 'sleep' : 'focused')
			const face = moyuFace(mood)
			// 跳舞时整只左右扭 + 上下颠，配合触手摆动像在蹦。
			// 只加 translate/rotate，不改布局 —— 不会把进度条挤动。
			const rootCls = 'dsw-moyu'
				+ (dance ? ' dsw-moyu-dance' : '')
				+ (stale ? ' dsw-moyu-stale' : '')
			return h('span', {
				style: { display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', lineHeight: 0 },
				title: props && props.title ? props.title : '墨鱼创作工作台'
			},
				h('style', null, MOYU_ANIM_CSS),
				h('svg', {
					className: rootCls,
					width: size, height: size, viewBox: '0 0 100 100',
					xmlns: 'http://www.w3.org/2000/svg',
					'aria-hidden': 'true'
				},
					// 触手：5 条独立路径，各自摆动
					h('g', { fill: '#1A1A1A' },
						h('path', { className: 'tn tn1', d: 'M24 68C20 76 20 84 24 88C28 92 33 90 33 84C33 78 30 72 29 68Z' }),
						h('path', { className: 'tn tn2', d: 'M37 74C34 82 34 90 38 93C42 96 46 93 46 87C46 81 43 77 42 74Z' }),
						h('path', { className: 'tn tn3', d: 'M50 76C49 84 49 92 52 95C56 98 59 94 58 88C57 82 54 78 53 76Z' }),
						h('path', { className: 'tn tn4', d: 'M63 74C66 82 66 90 62 93C58 96 54 93 54 87C54 81 57 77 58 74Z' }),
						h('path', { className: 'tn tn5', d: 'M76 68C80 76 80 84 76 88C72 92 67 90 67 84C67 78 70 72 71 68Z' })),
					// 头部（形象固定，换表情不动这里）
					h('path', { fill: '#1A1A1A', d: 'M50 10C30 10 14 26 14 46C14 58 19 68 27 73L73 73C81 68 86 58 86 46C86 26 70 10 50 10Z' }),
					// 青色菱形
					h('path', { fill: '#3DBFA0', d: 'M50 18L57 25L50 32L43 25Z' }),
					h('path', { fill: '#3DBFA0', d: 'M23 28L30 23L32 31L25 36Z' }),
					h('path', { fill: '#3DBFA0', d: 'M77 28L70 23L68 31L75 36Z' }),
					// 腮红
					h('ellipse', { cx: 28, cy: 60, rx: 6.5, ry: 4, fill: '#F98F72' }),
					h('ellipse', { cx: 72, cy: 60, rx: 6.5, ry: 4, fill: '#F98F72' }),
					// 眼睛 + 嘴 + 附加装饰：全部由表情决定
					face.eyes,
					face.mouth,
					face.extra || null))
		}

		// ── 跨工作台传参（2026-11-18 加）──
		//
		// 宿主的 ctx.layout.selectPanel(id) **只接收面板 id，没有参数通道**，
		// 但「在公众号的我的创作点无封面格子 → 跳到绘图台并带上这篇文章」需要传一个 draftId。
		//
		// 做法：一个模块级邮箱。发起方写好意图再切面板，接收方挂载时读走并清空。
		// 为什么放模块级而不是 window 全局：两个工作台在同一个 JS 模块里，共享这个作用域，
		// 用 window 反而会污染全局、还会在页面刷新后残留一条过期的意图。
		//
		// **接收方必须清空**：不清空的话，用户下次自己手动切到绘图台，
		// 会莫名其妙又关联上上次那篇文章。
		const JumpIntent = {
			pending: null,
			/** 发起：跳去绘图台做某篇文章的封面 */
			toCover: (draftId) => { JumpIntent.pending = { to: 'image', mod: '漫图创作', draftId: String(draftId) } },
			/** 接收：取走并清空。目标不是自己就原样留着，别的工作台还要用 */
			take: (to) => {
				const p = JumpIntent.pending
				if (!p || p.to !== to) return null
				JumpIntent.pending = null
				return p
			}
		}

				// ── 运行时可读配置 ──
		// 设置页改完调 reloadSettings 刷新。骨架确认这条直接影响写作 prompt 的措辞，
		// 所以必须运行时读，不能写死在模块顶层的数组里（会踩 let 的暂时性死区）。
		let WORKBENCH_SETTINGS = {}
		async function reloadSettings() {
			try {
				const r = await apiGet('/api/workbench/settings')
				const m = {}
				;(r && r.settings || []).forEach((it) => { m[it.key] = it.value })
				WORKBENCH_SETTINGS = m
			} catch (e) { /* 读不到就用默认 */ }
			return WORKBENCH_SETTINGS
		}
		function cfgBool(key, dflt) {
			const v = WORKBENCH_SETTINGS[key]
			if (v === undefined || v === '') return dflt
			return String(v) === '1'
		}
		/** 读字符串型配置。空值一律返回 dflt（"没填" 不等于 "要清空"）。 */
		function cfgStr(key, dflt) {
			const v = WORKBENCH_SETTINGS[key]
			if (v === undefined || v === null) return dflt
			const s = String(v).trim()
			return s === '' ? dflt : s
		}

		const S = {
			// 设置分组标题右边的作用范围标签
			setScope: {
				marginLeft: '8px', padding: '1px 7px', borderRadius: '5px',
				fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.2px',
				color: 'var(--dsw-alias-label-secondary)',
				background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)',
				verticalAlign: 'middle', cursor: 'help'
			},

			// ── 子工作台切换（公众号 / 绘图 / 技能库 / 设置）──
			//
			// 样式：底部一条贯穿的细线，选中项用一段实心短横压在上面。
			// 原来的「卡片式」（圆角上边框 + 白底）和下面那排模块标签长得太像，
			// 两层看起来是同一个层级。改成下划线后，两层的关系一眼能分开：
			//   上面这排是「换工作台」，下面那排是「换页」。
			appTabs: {
				display: 'flex', alignItems: 'stretch', gap: '2px',
				padding: '0 22px',
				// 贯穿全宽的底线：用 box-shadow 而不是 border-bottom，
				// 这样 1px 线不会把容器撑高，下面的内容不会跳。
				boxShadow: 'inset 0 -1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)'
			},
			appTab: {
				position: 'relative',
				padding: '11px 16px 10px',
				border: 'none', background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				font: 'inherit', fontSize: '13.5px', fontWeight: 600,
				cursor: 'pointer', whiteSpace: 'nowrap',
				// 选中态的下划线用 ::after 画不了（内联样式），
				// 改用 box-shadow 画在底部：2px 实心，贴住那条贯穿线。
				boxShadow: 'none'
			},
			appTabOn: {
				color: 'var(--dsw-alias-label-primary)', fontWeight: 700,
				// 下划线：2px 实心色条，inset 偏移到底部，正好压在贯穿线上
				boxShadow: 'inset 0 -2px 0 var(--dsw-alias-label-primary)'
			},
			// 悬停：未选中的给一点反馈，避免整排看着都是死的
			appTabHover: {
				color: 'var(--dsw-alias-label-primary)'
			},

			// ── 创作库操作列 ──
			yesMark: { fontSize: '12px', fontWeight: 600, color: '#067647' },
			noMark: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
			draftActions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap' },
			draftNext: { padding: '4px 11px', borderRadius: '7px', border: '1px solid var(--dsw-alias-label-primary)',
				background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)',
				font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flex: '0 0 auto' },
			draftCompose: { padding: '4px 11px', borderRadius: '7px', border: '1px solid #0b6bcb',
				background: '#0b6bcb', color: '#fff', font: 'inherit', fontSize: '12px',
				fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flex: '0 0 auto' },
			draftMinor: { display: 'flex', flex: '0 0 auto',
				borderLeft: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)',
				paddingLeft: '5px' },
			draftMinorBtn: { padding: '4px 7px', borderRadius: '6px', border: '1px solid transparent',
				background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
				font: 'inherit', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' },

			// ── 设置页 ──
			setHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', padding: '16px 0 14px' },
			setGroup: { margin: '20px 0 8px', fontSize: '12px', fontWeight: 640, letterSpacing: '0.04em',
				color: 'var(--dsw-alias-label-secondary)' },
			setSub: { margin: '14px 0 4px', fontSize: '12px', fontWeight: 600,
				color: 'var(--dsw-alias-label-primary)', opacity: 0.75 },
			setRow: { display: 'flex', gap: '18px', alignItems: 'flex-start', padding: '11px 0',
				borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)' },
			setLabel: { flex: '1 1 auto', minWidth: 0 },
			setHint: { margin: '3px 0 0', fontSize: '11.5px', lineHeight: 1.55,
				color: 'var(--dsw-alias-label-secondary)' },
			setMasked: { margin: '4px 0 0', fontSize: '11.5px', fontFamily: 'ui-monospace, Consolas, monospace',
				color: 'var(--dsw-alias-label-secondary)' },
			setCtrl: { flex: '0 0 auto', width: '300px', display: 'flex', justifyContent: 'flex-end' },
			setInput: { width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: '7px',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)',
				background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12.5px' },
			setSave: { padding: '6px 16px', borderRadius: '8px', border: '1px solid var(--dsw-alias-label-primary)',
				background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)',
				font: 'inherit', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', flex: '0 0 auto' },

			page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: '13px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif', color: 'var(--dsw-alias-label-primary)', position: 'relative' },
			tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center', padding: '12px 22px 10px', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)', flex: '0 0 auto' },
			tab: { padding: '5px 12px', borderRadius: '999px', cursor: 'pointer', font: 'inherit', background: 'transparent', whiteSpace: 'nowrap' },
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
				// 有 logo 的（墨鱼总入口）画 LOGO，其余仍用汉字首字。
				// 侧边栏收起时只剩图标，那里只有 18px —— 位图会糊，所以用 SVG data URI。
				if (app.logo) {
					return h('img', {
						src: MOYU_LOGO_URI,
						alt: app.label || '',
						width: size,
						height: size,
						style: {
							width: size + 'px', height: size + 'px',
							display: 'block', objectFit: 'contain',
							// 未选中时压一点亮度，和汉字图标的 opacity 反馈保持一致
							opacity: props && props.active ? 1 : 0.82
						}
					})
				}
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

		// ── 生成选题弹窗：手填预设 → 确定 → 入队并触发生成 ──
		const PRESET_FIELDS = [
			// 赛道：**按 5 个一级分组显示**（optgroups），不再是一长条平铺。
			// 15 个平铺时看不出体系，用户不知道「娱乐」和「情绪心理」是什么关系；
			// 分组后一眼看到 5 大类，找起来也快。
			// 「自动判断」放在最上面、不属于任何组 —— 它不是分类，是"让 Agent 定"。
			{ key: 'genre', label: '赛道', kind: 'select', leadOption: AUTO_GENRE,
			  optgroups: TRACK_GROUPS,
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
						h('div', { style: M.title }, '生成选题'),
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
									},
										// 有 optgroups 就分组渲染（赛道用它显示 5 个一级）。
										// 「自动判断」单独放最上面、不属于任何一级 ——
										// 它不是分类，是"让 Agent 自己定"的一个开关值。
										f.optgroups
											? [
												f.leadOption
													? h('option', { key: '__lead', value: f.leadOption }, f.leadOption)
													: null,
												...f.optgroups.map((g) => h('optgroup', {
													key: g.label, label: g.label
												}, g.items.map((o) => h('option', { key: o, value: o }, o))))
											]
											: (f.options || []).map((o) => h('option', { key: o, value: o }, o)))
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
			// 采集后是否自动生成选题。**从设置页读，不再用 localStorage**
			// （2026-11-18 改）：这个开关决定要不要花几分钟跑 Agent，属于长期偏好，
			// 存 localStorage 换台机器就丢，而且和设置页那一项会打架（两处各存一份）。
			// 本地仍留一份 state 供本页即时切换；改动会写回设置表。
			const [autoGen, setAutoGen] = React.useState(() => cfgBool('autoTopicEnabled', false))
			// 设置是异步加载的（reloadSettings 在 AppView 挂载时跑），
			// 首次渲染可能还是旧值。settingsReady 后同步一次，避免「明明开着却显示关」。
			React.useEffect(() => {
				setAutoGen(cfgBool('autoTopicEnabled', false))
			}, [WORKBENCH_SETTINGS.autoTopicEnabled])
			const putAutoGen = async (v) => {
				setAutoGen(v)
				try {
					await apiPost('/api/workbench/settings', { values: { autoTopicEnabled: v ? '1' : '0' } })
				} catch (err) { flash('保存开关失败：' + String((err && err.message) || err)) }
			}
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
									onChange: (ev) => putAutoGen(ev.target.checked)
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
									onChange: (ev) => putAutoGen(ev.target.checked)
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
										// 推荐赛道（2026-11-19 加）：采集时就打好的候选标签。
										// 放在「热度」前面 —— 挑素材时最该先看的是「这条能写哪几类」，
										// 热度高低是第二位的判断。
										h('th', { style: Object.assign({}, S.th, { width: '132px', whiteSpace: 'nowrap' }) }, '推荐赛道'),
										h('th', { style: S.th }, '热度'),
										h('th', { style: S.th }, '原文链接'),
										h('th', { style: S.th }, '话题日期'),
										h('th', { style: S.th }, '已生成选题'),
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
											// 推荐赛道：首选加粗，其余淡色。
											// 判不出来就显示「—」——**不塞兜底值**，
											// 塞个「文化与生活」会让人以为真判出来了。
											h('td', { style: S.td }, (() => {
												const ts = r.tracks || []
												if (!ts.length) {
													return h('span', {
														style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.6 },
														title: '标题里没有可判赛道的词，需要看原文才能定'
													}, '—')
												}
												return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
													ts.map((x, i) => h('span', {
														key: x.track,
														style: {
															fontSize: '11px', lineHeight: '1.5', whiteSpace: 'nowrap',
															fontWeight: i === 0 ? 650 : 400,
															color: i === 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'
														},
														// 悬停显示命中了哪些词 —— 让人知道这不是黑盒判断
														title: x.track + '（命中：' + (x.hits || []).join('、') + '，得分 ' + x.score + '）'
													}, x.track)))
											})()),
											h('td', { style: S.td }, fmtHot(r.hot)),
											h('td', { style: S.td }, r.url
												? h('a', { href: r.url, target: '_blank', rel: 'noreferrer noopener', style: S.mono }, '打开原文')
												: h('span', { style: S.mono }, '—')),
											h('td', { style: Object.assign({}, S.td, S.mono) }, r.date),
											// 是否已生成选题：独立一列，一眼扫得出来。
											// 以前是拿操作列的按钮状态兼职表达（按钮变成「已出选题」且禁用），
											// 那样这行能不能点要靠读按钮文字才知道，扫表不直观。
											h('td', { style: S.td },
												rowState[r.key] === 'analyzed'
													? h('span', { style: S.yesMark }, '是')
													: h('span', { style: S.noMark }, '否')),
											h('td', { style: S.td },
												rowState[r.key] === 'analyzed'
													// 已生成过的仍给个入口：想再出一版选题（换方向）时不用换平台重找
													? h('button', {
														style: Object.assign({}, S.mini, S.miniOff), type: 'button',
														disabled: !!pending[r.key],
														onClick: () => props.onPick(r)
													}, '再生成')
													: h('button', {
														style: S.mini, type: 'button', disabled: !!pending[r.key],
														onClick: () => props.onPick(r)
													}, pending[r.key] ? '生成中…'
														: rowState[r.key] === 'queued' ? '待生成 · 改参数' : '生成选题'))))))))))
		}

		// 取一条记录（草稿 / 发布 / 选题）的「来源」展示文本。
		// 后端已做三级回退（采集素材 > 选题标题 > 草稿主题），这里只负责挑字段。
		// source_kind 用来区分是哪一级，必要时给个前缀，别让人以为都是新闻素材。
		function sourceTextOf(r) {
			if (!r) return ''
			const v = r.source_display || r.source_title || r.draft_theme || r.topic_title || r.theme || ''
			return String(v || '').trim()
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


		// ── 设置页 ──
		// 密钥只回打码值：界面只需要知道「配没配」，不需要明文。
		function SettingsPanel(props) {
			const [items, setItems] = React.useState(null)
			const [draft, setDraft] = React.useState({})
			const [busy, setBusy] = React.useState(false)
			const [msg, setMsg] = React.useState('')

			// 支持两种筛选方式：
			//   group: 'image'            —— 单个工作台
			//   groups: ['gzh','image']   —— 多个工作台合并（公众号台既要自己的，也要生图项，
			//                                 因为它的「配图」流程要调 image-gen 出图）
			//   hideTextModel             —— 过滤掉 textModel* 那几项（只有生图台的润色/分镜用）
			// 都不传则显示全部。
			const groups = (props && props.groups) || null
			const group = (props && props.group) || ''
			const hideTextModel = !!(props && props.hideTextModel)

			// ── 会话清单（供 kind='session' 的下拉用）──
			//
			// 选项必须实时拉，不能写死在库里：会话随时会新增、改名、删除，
			// 存静态选项必然过期，而过期的选项会让用户「选了一个不存在的会话」
			// 却看不出来 —— 那比没有这个设置更糟。
			const [sessions, setSessions] = React.useState(null)
			const loadSessions = async () => {
				try {
					const remote = props && props.ctx && props.ctx.remote
					if (!remote || !remote.session || typeof remote.session.list !== 'function') {
						setSessions([])
						return
					}
					const listed = await remote.session.list({})
					const raw = (listed && listed.value && listed.value.items) || []
					const list = raw
						// 子会话和空白会话不能当投递目标：子会话是 Agent 自己派活的，
						// 空白会话还没有标题也没有上下文。
						.filter((s) => s && s.origin !== 'subagent' && s.blank !== true)
						.map((s) => ({
							sessionId: String(s.sessionId),
							title: sessionTitle(s) || String(s.sessionId).slice(0, 8),
							cwd: String(s.cwd || ''),
							running: sessionBusy(s),
							updatedAt: s.updatedAt || 0
						}))
						.sort((a, b) => b.updatedAt - a.updatedAt)
					setSessions(list)
				} catch (err) {
					setSessions([])
				}
			}
			React.useEffect(() => { loadSessions() }, [])
			const load = async () => {
				try {
					let all = []
					if (groups && groups.length) {
						for (const g of groups) {
							const r = await apiGet('/api/workbench/settings?group=' + encodeURIComponent(g))
							all = all.concat((r && r.settings) || [])
						}
					} else {
						const r = await apiGet('/api/workbench/settings' + (group ? '?group=' + encodeURIComponent(group) : ''))
						all = (r && r.settings) || []
					}
					if (hideTextModel) all = all.filter((it) => !String(it.key).startsWith('textModel'))
					setItems(all)
				} catch (err) {
					setMsg('读取失败：' + String((err && err.message) || err))
				}
			}
			React.useEffect(() => { load() }, [group, hideTextModel, (groups || []).join(',')])

			const setVal = (k, v) => setDraft((d) => Object.assign({}, d, { [k]: v }))

			// 会话类配置的保存值转换。
			//
			// 后端 set-settings 有一条规矩：空字符串 = 「没填」，跳过不覆盖。
			// 那条规矩对密钥是对的（留空表示不改），但对「选哪个会话」是致命的：
			// 用户选过某个会话之后，就再也切不回「自动」了 ——
			// 选自动发的是空串，被跳过，库里的旧 sessionId 永远留着。
			// 后端已经留了 __CLEAR__ 这个显式清空标记，这里把「选自动」翻译成它。
			const saveValues = () => {
				const out = {}
				Object.keys(draft).forEach((k) => {
					const it = items && items.find((x) => x.key === k)
					const v = draft[k]
					if (it && it.kind === 'session' && String(v) === '') out[k] = '__CLEAR__'
					else out[k] = v
				})
				return out
			}

			const save = async () => {
				if (!Object.keys(draft).length) { setMsg('没有改动'); return }
				setBusy(true); setMsg('')
				try {
					const r = await apiPost('/api/workbench/settings', { values: saveValues() })
					if (r && r.ok === false) throw new Error(JSON.stringify(r.error || r))
					setDraft({})
					const sk = (r && r.skipped) || []
					setMsg('已保存 ' + ((r && r.updated) || 0) + ' 项'
						+ (sk.length ? '（' + sk.length + ' 项留空未改）' : ''))
					await load()
					if (props.onSaved) await props.onSaved()
				} catch (err) {
					setMsg('保存失败：' + String((err && err.message) || err))
				} finally { setBusy(false) }
			}

			if (!items) return h('div', { style: { padding: '24px 22px', color: 'var(--dsw-alias-label-secondary)' } },
				msg || '读取中…')

			const row = (it) => {
				const changed = Object.prototype.hasOwnProperty.call(draft, it.key)
				const cur = changed ? draft[it.key] : ''
				const val = changed ? cur : (it.value || '')
				const isBool = it.kind === 'bool'
				const isChannel = it.kind === 'channel'
				const isSession = it.kind === 'session'
				return h('div', { key: it.key, style: S.setRow },
					h('div', { style: S.setLabel },
						h('div', { style: { fontWeight: 560 } }, it.label),
						it.hint ? h('div', { style: S.setHint }, it.hint) : null,
						it.kind === 'secret' && it.hasValue && !changed
							? h('div', { style: S.setMasked }, '当前：' + (it.masked || ''))
							: null,
						// 配的会话已经不在列表里 —— 必须说出来。
						// 静默改投最近活跃会让用户以为设置还生效，实际早已失效。
						// 具体投给了谁由下面那行「当前实际会投给」说，这里只点出失效原因。
						it.kind === 'session' && val && sessions && !sessions.some((x) => x.sessionId === val)
							? h('div', { style: Object.assign({}, S.setHint, { color: 'var(--dsw-alias-label-warning, #b26a00)' }) },
								'原先指定的会话已不存在（' + String(val).slice(0, 8) + '…）')
							: null,
						// 把「实际会投给谁」直接摆出来。
						//
						// 为什么必须有这一行：这个设置最典型的失败不是「设错了」，
						// 而是「以为设了、其实没生效」—— 比如配的会话后来被删了，
						// 程序会静默改投最近活跃，而那个会话可能是任意一个。
						// 只显示一个下拉框，用户永远看不出到底投给了谁。
						it.kind === 'session' && sessions
							? (() => {
								const r = resolveTargetSession(sessions, val)
								if (!r) return null
								// 配了却没按配的走 = 需要提醒（配的会话没了）。
								// 没配时走最近活跃是正常行为，不该报警。
								const warn = !!val && r.how !== '设置里指定的会话'
								return h('div', {
									style: Object.assign({}, S.setHint, {
										marginTop: '2px',
										color: warn ? 'var(--dsw-alias-label-warning, #b26a00)' : 'var(--dsw-alias-label-secondary)'
									})
								}, '当前实际会投给：' + r.title + '（' + r.how + '）')
							})()
							: null
					),
					h('div', { style: S.setCtrl },
						isSession
							? h('select', {
								// 值要落在 options 里，否则浏览器「显示第一项、实际值不变」。
								// 这里多一层：存着的 sessionId 可能指向已被删除的会话，
								// 那就退到空值（=不指定），并在下面用一行提示说明，
								// 免得用户看着下拉像选中了、其实指向一个不存在的会话。
								value: (sessions || []).some((x) => x.sessionId === val) ? val : '',
								onChange: (e) => setVal(it.key, e.target.value),
								style: S.setInput,
								disabled: sessions === null
							},
								h('option', { key: '__auto', value: '' },
									sessions === null ? '读取会话列表…' : '不指定（用最近活跃的会话）'),
								...(sessions || []).map((x) => h('option', {
									key: x.sessionId, value: x.sessionId
								},
									// 标题 + 目录名 + 运行状态：光有标题分不清同名会话，
									// 加上目录名就能认出「哪个项目的那个会话」。
									x.title
									+ (x.cwd ? '　·　' + x.cwd.split(/[\\/]/).filter(Boolean).pop() : '')
									+ (x.running ? '　·　运行中' : '')
								))
							)
							: isChannel
							? h('select', {
								// 值要落在 options 里，否则浏览器会「显示第一项、实际值不变」——
								// 看起来选中了、其实没选中，用户会以为已经切过去了。
								// 老库里 textModel 可能存着已移除的 'dsh'，这里统一归到第一项，
								// 保存时就会把这个陈旧值真正写掉。
								value: (() => {
									const opts = (it.options && it.options.length)
										? it.options
										: [{ value: 'grsai' }, { value: 'openai' }]
									const cur = val || ''
									if (opts.some((o) => o.value === cur)) return cur
									return (opts[0] && opts[0].value) || 'grsai'
								})(),
								onChange: (e) => setVal(it.key, e.target.value),
								style: S.setInput
							},
								// 选项可以由后端按 key 指定（it.options），没指定就用生图那两个默认值。
								// 文本模型通道要的是「DSH / OpenAI 兼容」，和生图不一样，
								// 所以不能写死一份。
								...((it.options && it.options.length)
									? it.options.map((o) => h('option', { key: o.value, value: o.value }, o.label))
									: [
										h('option', { key: 'grsai', value: 'grsai' }, 'GRS AI（官方）'),
										h('option', { key: 'openai', value: 'openai' }, 'OpenAI 兼容（第三方中转）')
									])
							)
							: isBool
								? h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer' } },
									h('input', {
										type: 'checkbox',
										checked: val === '1',
										// 不加「开启/关闭」文字：
										// 标签本身是「骨架要人工确认」，右边再写一个「关闭」，
										// 读者分不清关的是功能还是「人工确认」这件事，两个词还会互相矛盾。
										// 勾选状态自己就说明了开关，说明文字里也写了「开=…关=…」。
										onChange: (e) => setVal(it.key, e.target.checked ? '1' : '0')
									})
								)
							: it.kind === 'tracks'
								// 订阅赛道：多选 chip。值是「顿号分隔」的字符串 ——
								// 库里的 settings.value 是 TEXT，不是数组；
								// 用顿号而不是逗号，因为赛道名本身含空格（「AI 与科技」）。
								? (() => {
									const picked = String(cur || '').split('、').filter(Boolean)
									const toggle = (g) => {
										const next = picked.indexOf(g) >= 0
											? picked.filter((x) => x !== g)
											: picked.concat([g])
										setVal(it.key, next.join('、'))
									}
									const chip = (g) => {
										const on = picked.indexOf(g) >= 0
										return h('button', {
											key: g, type: 'button',
											style: {
												padding: '4px 11px', borderRadius: '999px',
												cursor: 'pointer', font: 'inherit', fontSize: '12.5px',
												border: '1px solid ' + (on
													? 'var(--dsw-alias-label-primary)'
													: 'color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)'),
												background: on
													? 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)'
													: 'transparent',
												color: on
													? 'var(--dsw-alias-label-primary)'
													: 'var(--dsw-alias-label-secondary)',
												fontWeight: on ? 650 : 400
											},
											onClick: () => toggle(g)
										}, g)
									}
									// 按 5 个一级分组显示：每组一个小标题 + 一行 chip。
									// 15 个平铺时看不出体系（「娱乐」和「情绪心理」什么关系？），
									// 分组后一眼看到 5 大类，也更容易判断"我该订哪几个"。
									return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
										TRACK_GROUPS.map((g) => h('div', { key: g.label },
											h('div', {
												style: {
													fontSize: '11px', fontWeight: 600, opacity: 0.55,
													marginBottom: '5px', whiteSpace: 'nowrap'
												}
											}, g.label),
											h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
												g.items.map(chip)))))
								})()
								: h('input', {
									type: it.kind === 'secret' ? 'password' : 'text',
									value: cur,
									placeholder: it.kind === 'secret'
										? (it.hasValue ? '已配置，留空表示不改' : '未配置，请填写')
										: (it.value || ''),
									onChange: (e) => setVal(it.key, e.target.value),
									style: S.setInput
								})
					)
				)
			}

			const byKeys = (keys) => {
				const out = []
				keys.forEach((k) => {
					const it = items.find((x) => x.key === k)
					if (it) out.push(row(it))
				})
				return out
			}

			// 一个分组 = 标题 + 字段。**组里一个字段都没有就整组不渲染**，
			// 免得别的工作台进来看到一排空标题。
			// extra 用于微信那种「有说明文字 + 动态槽位」的组，不靠 keys 判断有没有内容。
			// 某个字段当前该显示成什么值 —— 草稿优先，其次已存值
			const valOf = (key) => {
				if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
				const it = items.find((x) => x.key === key)
				return it ? (it.value || '') : ''
			}

			// 一组配置。第三个参数 extra 是额外内容，第四个 visibleIf 控制整组显隐：
			//   visibleIf = { key: 'textModel', equals: 'openai' }
			// 含义：只有当 textModel 这个字段的当前值是 openai 时，这一组才显示。
			//
			// 为什么需要它：文本模型的「接口地址 / Key / 模型名」只在 OpenAI 兼容通道下生效，
			// DSH 通道下它们填了也没用。原来只靠 hint 说一句「只在下生效」，
			// 输入框照样摆在眼前，用户会以为要填 —— 这是界面在误导人。
			// scope：这一组配置「给谁用」的标识。渲染成标题右边的小字标签。
			//   { text: '绘图工作台', hint: '鼠标悬停看到的完整说明' }
			// 为什么要这个：设置合并成一个面板后，生图模型和文本模型并排放着，
			// 用户看不出谁在哪儿用。加个范围标签，比在每项下面写长句清楚。
			const section = (title, keys, extra, visibleIf, scope) => {
				if (visibleIf) {
					const cur = String(valOf(visibleIf.key) || '').toLowerCase()
					const want = String(visibleIf.equals || '').toLowerCase()
					if (visibleIf.notEquals) {
						if (cur === String(visibleIf.notEquals).toLowerCase()) return null
					} else if (cur !== want) {
						return null
					}
				}
				const rows = byKeys(keys)
				const extras = (extra || []).filter(Boolean)
				// 判空要看 rows 和 extras 两边：
				//   微信公众号这一组 keys 是空的（5 个账号由 wechatSlots() 动态生成），
				//   只看 rows 会让整组消失 —— 2026-11-14 踩过。
				//   但不能反过来让「什么都没有的空组」也渲出个空标题，
				//   所以 rows 和 extras 都空才 return null。
				if (!rows.length && !extras.length) return null
				return h('div', { key: 'sec-' + title },
					h('div', { style: S.setGroup },
						h('span', null, title),
						scope && scope.text
							? h('span', {
								style: S.setScope,
								title: scope.hint || scope.text
							}, scope.text)
							: null),
					...rows,
					...extras
				)
			}

			// 微信槽位：填了 AppID 和 AppSecret 才算启用，由账号自己表达状态，
			// 不设「启用几个」这种会跟实际情况打架的配置项。
			const slotState = (i) => {
				const g = (k) => {
					const it = items.find((x) => x.key === k)
					if (!it) return ''
					if (Object.prototype.hasOwnProperty.call(draft, k)) return draft[k]
					return it.hasValue ? '1' : ''
				}
				return (g('wechat' + i + 'AppId') && g('wechat' + i + 'AppSecret'))
					? '  ✓ 已启用' : '  （未配置）'
			}

			const WECHAT_MAX = 5
			const wechatSlots = () => {
				const out = []
				for (let i = 1; i <= WECHAT_MAX; i++) {
					if (!items.find((x) => x.key === 'wechat' + i + 'AppId')) continue
					out.push(h('div', { key: 'slot' + i, style: S.setSub }, '账号 ' + i + slotState(i)))
					// 凭据三件套
					byKeys(['wechat' + i + 'Name', 'wechat' + i + 'AppId', 'wechat' + i + 'AppSecret'])
						.forEach((el) => out.push(el))
					// 自动创作订阅（2026-11-18 加）。
					//
					// 为什么必须放在**账号槽位里**而不是设置页底部：
					// 这两项描述的是「这个号每天写什么」，属于账号属性。
					// 放到页面底部会变成一堆 wechat1Tracks / wechat2Tracks 平铺，
					// 用户看不出哪个属于哪个号（15 个赛道 × 5 个账号就是 75 个 chip）。
					//
					// 只在凭据填了之后才显示（上面的 continue 已经保证），
					// 没配 AppId 的空槽位不该出现一堆订阅选项。
					byKeys(['wechat' + i + 'AutoWrite', 'wechat' + i + 'Tracks'])
						.forEach((el) => out.push(el))
				}
				return out
			}

			return h('div', { style: { padding: '0 22px 28px', overflow: 'auto' } },
				h('div', { style: S.setHead },
					h('div', { style: { fontSize: '15px', fontWeight: 640 } }, '设置'),
					h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
						msg ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, msg) : null,
						h('button', {
							type: 'button', disabled: busy || !Object.keys(draft).length,
							onClick: save, style: S.setSave
						}, busy ? '保存中…' : '保存')
					)
				),

				// 分组标题**按本组有没有字段**决定显不显示。
				// 生图工作台只拿到 group=image 的项，红狐/行为/微信三组一项都没有，
				// 以前标题写死，界面上就剩三个空标题 —— 看着像坏了。
				section('Redfox（热榜 / 爆文库）', ['redfoxKey']),

				// 投递目标：工作台给 Agent 下指令时投给哪个会话。
				// 单列一组，因为它跟 Redfox 密钥、微信账号不是一类东西，
				// 而且这是用户最容易「设了没生效」的一项，需要独立说清楚。
				section('公众号工作台', ['targetSessionId'],
					[],
					null,
					{ text: '关联会话', hint: '工作台的选题、写作、配图、发布指令都投给这个会话；留空则用最近活跃的会话' }),

				// 生图：只被 image-gen.py 读取，即绘图工作台出图用。
				// 公众号工作台的「配图」最终也是调 image-gen，所以也算它用得上。
				section('生图', ['imageChannel', 'imageBaseUrl', 'imageModel', 'imageModelKey', 'imageConcurrency', 'imageRetries'],
					[],
					null,
					{ text: '共用 · 出图', hint: '公众号工作台的「配图」和绘图工作台出图，都读这一组。改一次两边都生效' }),

				// 文本模型：image-gen.py 里被主题润色和 AI 智能分镜用。
				// **公众号工作台不用它** —— 那边的写作/审稿走 DSH 主对话模型。
				// 以前这一组没有标识，用户会以为它是「全局文本模型」。
				section('文本模型', ['textModel'],
					[],
					null,
					{ text: '仅绘图台 · 文字功能', hint: '绘图工作台的「主题润色」和「AI 智能分镜」用这一组。公众号写作不用它，走 DSH 主对话模型' }),
				// 三项**始终显示**，不再用 visibleIf 挂条件。
				//
				// 2026-11-16 踩过的坑：DSH 通道移除后，下拉只剩「OpenAI 兼容」一项，
				// 但老安装的库里 textModel 还存着旧值 'dsh'。
				// <select value="dsh"> 找不到匹配项时会**显示第一项**（=OpenAI 兼容），
				// 于是界面看着像已经选了 openai，实际值仍是 dsh：
				//   · visibleIf 按真实值 dsh 判断 → 不通过 → 下面三项被藏起来
				//   · 下拉又只剩一项 → 选不中别的 → 触发不了 onChange
				// 用户被卡死：看不到配置项，也没法切通道。
				// 现在改成常显：通道只剩一种，配置项就是必填项，藏起来只会误导人。
				section('文本模型 · OpenAI 兼容配置',
					['textModelBaseUrl', 'textModelModel', 'textModelKey'],
					[],
					null,
					{ text: '仅绘图台 · 文字功能', hint: '同上：只在绘图工作台的润色/分镜里生效' }),

				section('行为', ['confirmSkeleton', 'materialKeepDays']),

				// 选题自动生成：开关 + 订阅赛道 + 每次取几条。
				// 放在设置页而不是热榜页：它是长期偏好，
				// 而热榜页那个勾选存的是 localStorage，换台机器就丢了。
				section('选题自动生成',
					['autoTopicEnabled', 'topicTracks', 'autoTopicCount']),

				// 每日自动创作（2026-11-18 加）。
				//
				// 为什么单列一组而不是塞进「选题自动生成」：
				// 那一组管的是「采集完要不要顺手生成选题」，是一次性的、十几秒的事；
				// 这一组管的是「每天早上自动跑完整条写稿流水线」，
				// 会连跑十几分钟。两件事的风险和成本不是一个量级。
				//
				// **不含配图**：用户要求「我检查没问题再手工配图」。
				// 自动配图会烧生图额度，而且图合不合适得看过正文才知道。
				section('每日自动创作',
					['autoWriteEnabled', 'autoWriteTime'],
					[],
					{ text: '自动跑到「已排版」，不配图、不入草稿箱、不群发',
					  hint: '开启后每天定时采集热榜 → 生成选题 → 按账号订阅赛道各挑 1 篇最优 → 写稿排版。'
						+ '停在「已排版」等你检查后手工配图。账号订阅在下方「微信公众号」里配置。' }),

				section('微信公众号', [], [
					h('div', { style: Object.assign({}, S.setHint, { margin: '0 0 4px' }) },
						'填了 AppID 和 AppSecret 的账号才算启用，其余留空即可。'),
					...wechatSlots()
				])
			)
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

			// 爆文行 → 生成选题的形状（与热榜行同构，所以直接复用 props.onPick）
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
						? h('button', { style: Object.assign({}, S.mini, S.miniOff), type: 'button', disabled: false, onClick: () => pick(r) }, '再生成')
						: h('button', {
							style: S.mini, type: 'button', disabled: !!pending[r.key],
							onClick: () => pick(r)
						}, pending[r.key] ? '生成中…'
							: rowState[r.key] === 'queued' ? '待生成 · 改参数' : '生成选题'),
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

					// 操作：主操作靠右，次要操作在它左边。
					// 「去创作」是主操作，用实心主色区分；其余保持描边。
					h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center',
						marginTop: 'auto', paddingTop: '10px', flexWrap: 'wrap',
						justifyContent: 'flex-end' } },
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
						}, '去创作'),
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
						? h('div', { style: S.placeholder }, '还没有选题方案。到「每日热榜」或「爆文库」点【生成选题】入队，再由 Agent 跑选题 skill 产出。')
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
							h('div', { style: D.v }, sourceTextOf(sel) || '（无来源：手工添加的选题）'),
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
							}, sel.status === 'selected' ? '取消选定' : '去创作'),
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
/* 待配图占位框：也用于**创作台预览**（那里容器不是 .wb-article，是 C.preview）。
   不加这一条的话，创作台里 placeholder 会渲染成没样式的裸 div。
   2026-11-18 加：用户反馈「位图是一个烂图」，实际是还没配图时浏览器显示破图图标。 */
.wb-ph-box { min-height: 84px; margin: 18px 0; padding: 12px 16px;
  border: 1px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent);
  border-radius: 8px; display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6;
  text-align: center; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); }
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
										dangerouslySetInnerHTML: { __html: placeholderToBox(props.html || '') }
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

		// 封面 URL：兼容两种存法。
		// 新数据存完整相对路径（drafts/xxx/imgs/cover.png），老数据只存文件名（cover.png）。
		// 以前一律拼「草稿目录 + cover」，新数据就会被拼成两遍，返回 404 → 破图。
		function coverUrl(row) {
			const cov = String((row && row.cover) || '').trim()
			if (!cov) return ''
			// 已经是完整相对路径：直接用
			if (cov.indexOf('/') >= 0) return '/api/workbench/asset?p=' + encodeURIComponent(cov)
			// 只有文件名：拼上草稿目录
			const dir = String((row && row.path) || '')
			const base = dir && !dir.endsWith('/') ? dir + '/' : dir
			return '/api/workbench/asset?p=' + encodeURIComponent(base + cov)
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
		// preset 来自选题库（去创作带入），也可能为空（手工新建）。
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

			const inline = !!props.inline


			// inline 模式下不画遮罩、不画外框，直接铺进父容器；
			// 弹窗模式保持原样（居中、有边框、有投影）。
			const shell = inline
				? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
					background: 'transparent', color: 'var(--dsw-alias-label-primary)' }
				: M.box

			return h('div', { style: inline ? { flex: '1 1 auto', minHeight: 0, display: 'flex' } : M.overlay },
				h('div', { style: shell },
					inline ? null : h('div', { style: M.head },
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
						inline ? null : h('button', {
							style: M.btn, type: 'button', disabled: busy, onClick: props.onClose
						}, '取消'),
						h('button', {
							style: canStart ? M.primary : M.primaryOff,
							type: 'button', disabled: !canStart, onClick: submit
						}, busy ? '正在提交…' : (preset.draftId ? '重新生成' : '开始创作'))))
			)
		}

		// ── 文字风格库 ────────────────────────────────────────────────
		// 与生图工作台那个「风格库」不是一回事：那是图片画风（handraw 367 个），
		// 这是**文字语气**，是写作技能之下的变体。所以两个模块同名但不同维度。

		// ── 创作台样式 ──
		const C = {
			page: { display: 'flex', gap: '0', height: '100%', minHeight: 0, alignItems: 'stretch' },
			// 左栏固定 420px：再宽就挤右侧预览，再窄表单会折行
			left: { flex: '0 0 520px', display: 'flex', flexDirection: 'column',
				minHeight: 0, borderRight: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)' },
			leftHead: { padding: '16px 18px 10px', flex: '0 0 auto' },
			leftTitle: { fontSize: '15px', fontWeight: 650 },
			leftSub: { marginTop: '4px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
			leftBody: { flex: '1 1 auto', overflow: 'auto', padding: '4px 18px 16px',
				display: 'flex', flexDirection: 'column', gap: '15px' },
			leftFoot: { flex: '0 0 auto', padding: '12px 18px 16px',
				borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)' },
			group: { display: 'flex', flexDirection: 'column', gap: '6px' },
			label: { fontSize: '12.5px', fontWeight: 600 },
			labelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' },
			hint: { fontSize: '11.5px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
			counter: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
			warn: { color: '#b54708' },
			chips: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
			chip: { padding: '5px 11px', borderRadius: '999px', cursor: 'pointer', font: 'inherit',
				fontSize: '12px', background: 'transparent',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
				color: 'var(--dsw-alias-label-secondary)' },
			chipOn: { border: '1px solid var(--dsw-alias-label-primary)',
				color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
			input: { width: '100%', boxSizing: 'border-box', padding: '8px 11px', borderRadius: '8px',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)',
				background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12.5px' },
			textarea: { minHeight: '96px', resize: 'vertical', lineHeight: 1.7,
				fontFamily: 'inherit' },
			styleGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px',
				maxHeight: '180px', overflowY: 'auto' },
			styleCard: { padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', font: 'inherit',
				textAlign: 'left', background: 'transparent',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)' },
			styleCardOn: { border: '1px solid var(--dsw-alias-label-primary)',
				background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)' },
			styleName: { fontSize: '12px', fontWeight: 560, whiteSpace: 'nowrap',
				overflow: 'hidden', textOverflow: 'ellipsis' },
			styleMeta: { fontSize: '10.5px', marginTop: '2px',
				color: 'var(--dsw-alias-label-secondary)' },
			// ── 进度条（居中一条）──
			progWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center',
				justifyContent: 'center', minHeight: '62vh', padding: '0 24px', gap: '14px' },
			progStage: { fontSize: '15px', fontWeight: 600 },
			// 进度条外框：给墨鱼留出站的位置。
			// track 自己带 overflow:hidden（防止填充条溢出圆角），
			// 但墨鱼要露在条外面，所以把定位容器放在外面一层。
			// paddingTop 要跟着墨鱼尺寸走：56px 的墨鱼有一半在条上方，
			// 留 40px 才不会被上面的标题压住。
			progTrackWrap: { position: 'relative', width: '100%', maxWidth: '520px',
				paddingTop: '40px' },
			progTrack: { width: '100%', height: '6px', borderRadius: '3px',
				overflow: 'hidden',
				background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 13%, transparent)' },
			progFill: { height: '100%', borderRadius: '3px',
				background: 'var(--dsw-alias-label-primary)', transition: 'width .5s ease' },
			progMeta: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)' },
			progHint: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.8 },
			// ── 文章预览顶栏 ──
			previewBar: { display: 'flex', alignItems: 'center', gap: '8px',
				paddingBottom: '10px', marginBottom: '12px',
				borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)' },
			miniPri: { padding: '4px 11px', borderRadius: '7px', cursor: 'pointer', font: 'inherit',
				fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap',
				border: '1px solid var(--dsw-alias-label-primary)',
				background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)' },
			editorWrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
			editorArea: { flex: '1 1 auto', width: '100%', boxSizing: 'border-box', minHeight: '420px',
				padding: '14px 16px', borderRadius: '8px', resize: 'none',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
				background: 'transparent', color: 'inherit', font: 'inherit',
				fontSize: '12.5px', lineHeight: 1.85,
				fontFamily: 'ui-monospace, Consolas, "Courier New", monospace' },
			editMsg: { fontSize: '11.5px', padding: '6px 0', color: 'var(--dsw-alias-label-secondary)' },
			previewTag: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
			fields: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px',
				padding: '12px 0 14px', marginBottom: '4px',
				borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)' },
			fieldBlock: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
			fieldTitle: { fontSize: '11.5px', fontWeight: 600,
				color: 'var(--dsw-alias-label-secondary)' },
			fieldValue: { fontSize: '12.5px', lineHeight: 1.7, wordBreak: 'break-word' },
			fieldHint: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)',
				wordBreak: 'break-all' },
			previewWrap: { paddingTop: '14px' },
			primary: { width: '100%', padding: '10px', borderRadius: '9px', cursor: 'pointer',
				border: '1px solid var(--dsw-alias-label-primary)',
				background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)',
				font: 'inherit', fontSize: '13px', fontWeight: 650 },
			primaryOff: { width: '100%', padding: '10px', borderRadius: '9px', cursor: 'default',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)',
				background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
				font: 'inherit', fontSize: '13px', fontWeight: 600 },
			err: { marginBottom: '8px', fontSize: '11.5px', color: '#b42318' },
			right: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
			rightHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
				gap: '12px', padding: '16px 22px 10px', flex: '0 0 auto' },
			rightTitle: { fontSize: '15px', fontWeight: 650 },
			stageChip: { padding: '2px 9px', borderRadius: '999px', fontSize: '11.5px',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent)' },
			mini: { padding: '4px 10px', borderRadius: '7px', cursor: 'pointer', font: 'inherit',
				fontSize: '11.5px', background: 'transparent',
				border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)',
				color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
			rightBody: { flex: '1 1 auto', overflow: 'auto', padding: '0 22px 22px', minHeight: 0 },
			empty: { padding: '48px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' },
			preview: { fontSize: '14px', lineHeight: 1.95, maxWidth: '720px', margin: '0 auto' }
		}

		// ── 创作台：左配置 / 右预览 ──
		// 左栏复用 DraftConfig（inline 模式），字段与弹窗天然一致。
		//
		// 右侧三态（2026-11-13 重做）：
		//   ① 没有进行中的稿 → 空态，提示去左边填
		//   ② 正在写（还没有正文）→ 居中一条进度条，显示阶段 + 百分比 + 字数
		//   ③ 写完了（有正文）→ 直接显示文章预览
		// 之前是三态混在一个分支里，结果「还没有开始写」和进度同时出现。
		function ComposeStudio(props) {
			const [preset, setPreset] = React.useState(props.preset || {})
			const [draftId, setDraftId] = React.useState((props.preset || {}).draftId || null)
			const [stage, setStage] = React.useState('')
			const [words, setWords] = React.useState(0)
			const [curDraft, setCurDraft] = React.useState({})
			const [preview, setPreview] = React.useState('')
			// 预览同时存两份：html 给渲染，text 给「复制源码」。
			// 只存 html 的话没法复制 markdown，存两份最省事。
			const [previewText, setPreviewText] = React.useState('')
			const [previewBusy, setPreviewBusy] = React.useState(false)
			const [booting, setBooting] = React.useState(true)

			// 手动编辑态：拿到 draft.md 源码后切过去。
			// 只改源文件，不改 article.html —— 后者是 finalize 产物，改了会被覆盖。
			const [editing, setEditing] = React.useState(false)
			const [editText, setEditText] = React.useState('')
			const [editBusy, setEditBusy] = React.useState(false)
			const [editMsg, setEditMsg] = React.useState('')
			// 开始写作的时间戳（毫秒）。用于进度条估算「已经写了多久」。
			// 提交成功就设上，拿到正文就清掉。
			const [writingSince, setWritingSince] = React.useState(0)

			const lastRef = React.useRef({ words: -1, stage: '' })

			// ── 进入时：先看有没有「进行中」的稿 ──
			// 用户要求：进来要接着上次的活，不能每次都是空白页。
			// 「进行中」= status 不在 draftbox / published 里，按更新时间取最新一条。
			React.useEffect(() => {
				let alive = true
				;(async () => {
					// 带了 preset.draftId 就是明确要看那一篇，不用猜
					if (draftId) { setBooting(false); return }
					// 从选题库【去创作】进来：props.preset 里带着 topicId 和整套素材，
					// 这时候绝不能去恢复「上一次的草稿」——那会把新选题覆盖掉。
					// 2026-11-16 踩过：点去创作，左栏显示的是上一篇旧稿。
					if ((props.preset || {}).topicId) { setBooting(false); return }
					// 用户上次点过「新建创作」→ 停在空白页，别自动接续
					let fresh = false
					let lastOpen = ''
					try {
						fresh = window.sessionStorage.getItem('wb-compose-fresh') === '1'
						lastOpen = window.sessionStorage.getItem('wb-compose-current') || ''
					} catch (e) { /* 忽略 */ }
					if (fresh) { setBooting(false); return }
					try {
						const r = await apiGet('/api/workbench/drafts')
						const list = (r.drafts || []).filter((x) =>
							x.status && x.status !== 'draftbox' && x.status !== 'published')
						if (!alive || !list.length) { setBooting(false); return }

						// ① 优先接「上次在创作台打开的那一篇」——用户切走前看的是它
						let one = lastOpen
							? list.find((x) => String(x.id) === String(lastOpen))
							: null
						// ② 没有记录才退回按更新时间挑
						if (!one) {
							list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
							one = list[0]
						}
						if (!one) { setBooting(false); return }
						let cfg = {}
						try { cfg = JSON.parse(one.config_json || '{}') } catch (e) { cfg = {} }

						// 把草稿回填成 preset，左栏就能回显当时的配置
						setPreset({
							draftId: one.id,
							topicId: one.topic_id || null,
							title: one.title || '',
							theme: one.theme || one.title || '',
							materials: one.materials || '',
							requirement: one.requirement || one.viewpoint || '',
							genre: one.track || '',
							skill: one.skill || '',
							config: cfg,
							status: one.status,
							word_count: one.word_count
						})
						setDraftId(one.id)
						setStage(one.status || '')
						setWords(one.word_count || 0)
						setCurDraft(one)
					} catch (e) { /* 读不到就当没有 */ }
					finally { if (alive) setBooting(false) }
				})()
				return () => { alive = false }
			}, [])

			// 记住「创作台当前打开的是哪一篇」。
			// 切走再回来时优先接它，而不是按时间猜 —— 猜会接错稿。
			React.useEffect(() => {
				try {
					if (draftId) window.sessionStorage.setItem('wb-compose-current', String(draftId))
					else window.sessionStorage.removeItem('wb-compose-current')
				} catch (e) { /* 忽略 */ }
			}, [draftId])

			// 1 秒 tick：写作中进度条要一直动，不能只有 3 秒轮询时才跳一下。
			// 只刷「重算时间」这一件事，不碰网络。
			const [, setTick] = React.useState(0)
			React.useEffect(() => {
				if (!writingSince) return
				const t = setInterval(() => setTick((n) => n + 1), 1000)
				return () => clearInterval(t)
			}, [writingSince])

			const pullPreview = async (id) => {
				if (!id) return
				setPreviewBusy(true)
				try {
					// 接口返回的是 html（已渲染好，含正文图），不是 content。
					// 之前读 r.content 永远是空，所以预览一直白着。
					const r = await apiGet('/api/workbench/draft-content?id=' + id)
					setPreview((r && (r.html || r.text)) || '')
					// text 是 markdown 源码，单独存一份给「复制源码」用
					setPreviewText((r && r.text) || '')				} catch (e) { /* 还没落盘就空着 */ }
				finally { setPreviewBusy(false) }
			}

			React.useEffect(() => {
				if (!draftId) return
				pullDraft(draftId)
				pullPreview(draftId)
				const t = setInterval(() => pullDraft(draftId), 3000)
				return () => clearInterval(t)
			}, [draftId])

			// 新建创作：把所有状态打回初始值。
			// key 换掉是为了让 DraftConfig 的 useState 重新按空 preset 初始化 ——
			// 只清 preset 内容而不换 key，组件内部状态（技能、风格、字数）不会跟着重置。
			const [newSeq, setNewSeq] = React.useState(0)
			const newCompose = () => {
				// 记一下「用户主动要新建」，切走再回来时不要再自动接续。
				try {
					window.sessionStorage.setItem('wb-compose-fresh', '1')
					window.sessionStorage.removeItem('wb-compose-current')
				} catch (e) {}
				// 外层 composePreset 也要清：不清的话切走再回来，
				// props.preset 又把上一轮的选题塞回来（2026-11-16 踩过）。
				if (props.onResetPreset) props.onResetPreset()
				setPreset({})
				setDraftId(null)
				setStage('')
				setWords(0)
				setCurDraft({})
				setPreview('')
				setEditing(false)
				setEditText('')
				setEditMsg('')
				lastRef.current = { words: -1, stage: '' }
				setNewSeq((n) => n + 1)
			}

			const pullDraft = async (id) => {
				if (!id) return
				try {
					const r = await apiGet('/api/workbench/drafts')
					const one = (r.drafts || []).find((x) => x.id === id)
					if (!one) return
					const w = one.word_count || 0
					const st = one.status || ''
					setStage(st)
					setWords(w)
					setCurDraft(one)
					// 有字数了说明 Agent 已经写出东西，停掉「已等 N 秒」计时
					if (w > 0) setWritingSince(0)
					const prev = lastRef.current
					if (w !== prev.words || st !== prev.stage) {
						lastRef.current = { words: w, stage: st }
						if (w > 0 || st !== 'queued') pullPreview(id)
					}
				} catch (e) { /* 静默 */ }
			}


			const openEditor = async () => {
				if (!draftId) return
				setEditBusy(true); setEditMsg('')
				try {
					const r = await apiGet('/api/workbench/draft-content?id=' + draftId)
					// text 是 markdown 源码；html 是渲染产物。编辑用 text。
					setEditText((r && r.text) || '')
					setEditing(true)
				} catch (e) {
					setEditMsg('读取失败：' + String((e && e.message) || e))
				} finally { setEditBusy(false) }
			}

			// 保存：写 draft.md → 提示用户重跑排版
			// 不自动跑 finalize：那是 Agent 的活，前端只负责把字存对。
			const saveEditor = async () => {
				if (!draftId) return
				setEditBusy(true); setEditMsg('')
				try {
					const r = await apiPost('/api/workbench/draft-content', { id: draftId, text: editText })
					if (r && r.ok === false) throw new Error(r.error || '保存失败')
					setEditing(false)
					// 后端保存后会自动重排一次（finalize），所以这里直接刷新预览。
					// 重排失败也不影响正文：正文已存，只是预览还是旧的，说清楚就行。
					const rlErr = r && r.relayoutError
					setEditMsg(rlErr
						? '⚠️ 正文已保存（' + ((r.words) || 0) + ' 字），但自动排版失败：' + rlErr
							+ '　可以到「我的创作」点【排版】重试。'
						: '✅ 已保存并重新排版（' + ((r && r.words) || 0) + ' 字），旧版备份为 draft.md.bak。')
					await pullDraft(draftId)
					await pullPreview(draftId)
				} catch (e) {
					setEditMsg('保存失败：' + String((e && e.message) || e))
				} finally { setEditBusy(false) }
			}

			const onStart = async (cfg) => {
				const r = await props.onStart(cfg)
				const nid = (r && (r.id || r.draftId)) || (cfg && cfg.draftId) || null
				// 已经开始写了，清掉 fresh 标记：下次进创作台要接续这篇，不是空白页
				try { window.sessionStorage.removeItem('wb-compose-fresh') } catch (e) {}
				if (nid) {
					setDraftId(nid)
					setPreview('')
					setWritingSince(Date.now())    // 开始计时
					lastRef.current = { words: -1, stage: '' }
				}
				return r
			}

			const STAGE_LABEL = {
				queued: '排队中', draft: '写初稿', polished: '打磨中', reviewed: '审稿中',
				formatted: '排版中', illustrated: '配图中', draftbox: '已入草稿箱', published: '已群发'
			}
			const stageText = stage ? (STAGE_LABEL[stage] || stage) : ''
			const cur = stage ? DRAFT_STAGES.indexOf(stage) : -1

			// 目标字数：从 config_json 里取，取不到就不显示分母
			let targetWords = 0
			try {
				const c = JSON.parse(curDraft.config_json || '{}')
				targetWords = Number(c.words) || 0
			} catch (e) { targetWords = 0 }

			// 进度百分比。
			//
			// 2026-11-13 修：原来是「有字数按字数算，没字数按阶段算」，
			// 但写稿全程 word_count 是 NULL、status 停在 queued，
			// 于是永远落在 (0+1)/8 = 12.5% ≈ 13%，看着像卡住。
			//
			// 现在分三种：
			//   ① 有真实字数 → 按字数算（最准）
			//   ② 写作中（有 draftId、没正文）→ 按「已等待时间」估算，并封顶 95%
			//   ③ 其他 → 按阶段算
			const waiting = writingSince ? Math.floor((Date.now() - writingSince) / 1000) : 0
			// done 必须在 pct 之前声明：pct 的 IIFE 里用到了它。
			// 原来 done 写在 pct 后面，const 的暂时性死区会让整个组件崩（白屏）。
			const done = !!(preview && String(preview).trim())
			const pct = (() => {
				if (targetWords > 0 && words > 0) {
					return Math.max(2, Math.min(99, Math.round((words / targetWords) * 100)))
				}
				if (writingSince && !done) {
					// Agent 写一篇 1500-2000 字大约 3-8 分钟。
					// 用 300 秒做半程：到 300 秒约走到 60%，之后逼近 95% 但不到 100。
					const est = 95 * (1 - Math.exp(-waiting / 220))
					return Math.max(3, Math.min(95, Math.round(est)))
				}
				if (cur >= 0) return Math.round(((cur + 1) / DRAFT_STAGES.length) * 100)
				return 0
			})()


			// ── 三态之一：写作中的进度条（居中，一条） ──
			// 墨鱼走在填充条的**末端**：它是「正在推进到哪」的指示物，
			// 站在条外面跟着百分比移动，比再加一条纯色更直观。
			// 用绝对定位挂在 track 的右手边（left = pct%），不占条本身的布局。
			//
			// 尺寸 30 → 56：用户反馈 30px 看不清表情。56px 下眼睛和嘴都能辨认，
			// 也还不会把进度条显得又矮又挤（外框 paddingTop 同步加到 36）。
			const PROG_MOYU = 56
			// 按进度换表情：让「进行到哪」除了数字还有一层可读的反馈。
			// 分段不按阶段数均分，而是按**体感**：
			//   0–35   刚开工，专注盯着
			//   35–70  顺起来了，开心
			//   70–99  快好了，得意（星星眼）
			//   100    撒花
			const moodOf = (p, isDone) => {
				if (isDone) return 'cheer'
				if (p >= 70) return 'star'
				if (p >= 35) return 'happy'
				return 'focused'
			}
			const progressView = h('div', { style: C.progWrap },
				h('div', { style: C.progStage }, stageText || '准备中'),
				h('div', { style: C.progTrackWrap },
					h('div', { style: C.progTrack },
						h('div', { style: Object.assign({}, C.progFill, { width: pct + '%' }) })),
					// 墨鱼：跟着百分比走，回弹曲线让它像一路小跑过去
					h('span', {
						style: {
							position: 'absolute', top: '50%', left: pct + '%',
							transform: 'translate(-50%, -68%)',
							transition: 'left .5s cubic-bezier(.34,1.3,.64,1)',
							pointerEvents: 'none'
						}
					}, h(MoyuMascot, {
						size: PROG_MOYU,
						mood: moodOf(pct, done),
						dance: !done
					}))),
				h('div', { style: C.progMeta },
					pct + '%'
					+ (words > 0 ? '　·　已写 ' + words + ' 字' + (targetWords ? ' / ' + targetWords : '') : '')
					+ (stageText ? '　·　' + stageText : '')
					+ (writingSince ? '　·　已等 ' + Math.floor(waiting / 60) + ' 分 ' + (waiting % 60) + ' 秒' : '')
					+ (previewBusy ? '　·　读取正文中…' : '')),
				h('div', { style: C.progHint },
					'写完会自动显示全文，不用手动刷新。Agent 正在后台写，这个百分比是估算值。'))

			// ── 后续操作 ──
			// 按当前阶段给按钮，不要把所有阶段的操作一次性摆出来——
			// 那样用户得自己判断「现在该点哪个」。
			const nextAction = DRAFT_ACTION[stage]
			const canAdvance = !!nextAction && !!props.onAdvance

			const actionBar = h('div', { style: C.previewBar },
				h('span', { style: C.previewTag }, '全文 ' + words + ' 字'),
				stage ? h('span', { style: C.stageChip }, stageText) : null,
				h('span', { style: { flex: '1 1 auto' } }),
				// 复制到公众号：走富文本剪贴板，粘进公众号编辑器直接带格式。
				// 和「全文」窗口里的那个按钮同一套实现，不另写一份。
				h('button', {
					type: 'button', style: C.mini,
					disabled: !preview,
					title: '复制带格式正文，可直接粘贴到公众号编辑器',
					onClick: () => {
						if (!preview) { if (props.onToast) props.onToast('正文还没加载'); return }
						copyRich(preview, previewText || '',
							(msg) => { if (props.onToast) props.onToast(msg || '已复制带格式正文，可直接粘贴到公众号编辑器') },
							(msg) => { if (props.onToast) props.onToast(msg) })
					}
				}, '复制到公众号'),
				// 复制源码：markdown 原文，粘到别处用
				h('button', {
					type: 'button', style: C.mini,
					disabled: !previewText,
					title: '复制 markdown 源码',
					onClick: () => {
						if (!previewText) { if (props.onToast) props.onToast('没有源码可复制'); return }
						copyText(previewText, () => { if (props.onToast) props.onToast('已复制 markdown 源码') })
					}
				}, '复制源码'),
				h('button', {
					type: 'button', style: C.mini,
					onClick: openEditor
				}, editBusy ? '读取中…' : '手动编辑'),
				h('button', {
					type: 'button', style: C.mini,
					onClick: () => pullPreview(draftId)
				}, previewBusy ? '刷新中…' : '刷新'),
				// 主操作：推进到下一阶段
				canAdvance ? h('button', {
					type: 'button', style: C.miniPri,
					onClick: () => props.onAdvance(curDraft)
				}, nextAction) : null,
				// 配图：只在 formatted 阶段出现，和创作库那边保持同一套规则
				stage === 'formatted' && props.onComposeImages ? h('button', {
					type: 'button', style: C.miniPri,
					onClick: () => {
						if (!window.confirm(
							'配图会生成封面 + 4-6 张正文图，用掉一次生图额度。\n\n' +
							'文章已经定稿了吗？改稿后再配一次要重新生成全部图片。'
						)) return
						props.onComposeImages(curDraft)
					}
				}, '配图') : null,
				h('button', {
					type: 'button', style: C.mini,
					onClick: () => props.onOpenDraft && props.onOpenDraft(draftId)
				}, '去我的创作'))

			// ── 三态之二：写完了，直接看文章 ──
			const previewView = h('div', { style: C.previewWrap },
				actionBar,
								h('div', { style: C.preview, dangerouslySetInnerHTML: { __html: placeholderToBox(preview) } }))

			// ── 三态之零：空白页 ──
			const emptyView = h('div', { style: C.empty },
				h('div', { style: { fontSize: '14px', marginBottom: '8px' } }, '还没有开始写'),
				h('div', { style: C.hint }, '填完左侧，点【开始创作】。写的过程中这里会显示进度，写完直接出全文。'))

			// 编辑态：整个右栏换成文本框
			const editorView = h('div', { style: C.editorWrap },
				h('div', { style: C.previewBar },
					h('span', { style: C.previewTag }, '编辑 draft.md（源文件）'),
					h('span', { style: { flex: '1 1 auto' } }),
					h('button', {
						type: 'button', style: C.mini, disabled: editBusy,
						onClick: () => { setEditing(false); setEditMsg('') }
					}, '取消'),
					h('button', {
						type: 'button', style: C.miniPri, disabled: editBusy,
						onClick: saveEditor
					}, editBusy ? '保存中…' : '保存')),
				editMsg ? h('div', { style: C.editMsg }, editMsg) : null,
				h('textarea', {
					style: C.editorArea,
					value: editText,
					spellCheck: false,
					onChange: (e) => setEditText(e.target.value)
				}),
				h('div', { style: C.hint },
					'改的是 draft.md。保存后 article.html 还是旧的，' +
					'要到「我的创作」点【排版】重新生成才会生效。'))

			const right = h('div', { style: C.right },
				h('div', { style: C.rightHead },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
						// 显示**文章标题**而不是「文章」两个字。
						// 「文章」是占位文字，看久了不知道这是哪一篇；
						// 而且用户在左边改主题时，右边标题栏应该能对上。
						// 标题取不到（还没写出来）就退回「生成进度」。
						h('div', {
							style: Object.assign({}, C.rightTitle, {
								overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
							}),
							title: done ? (curDraft.title || '文章') : '生成进度'
						}, done
							? (curDraft.title || '文章')
							: '生成进度'),
						done && draftId ? h('span', { style: C.stageChip }, stageText) : null),
					// 新建创作：清空左右两侧，回到「填表 → 开始创作」的起点。
					// 有了它，不挂选题也能手工写一篇。
					h('button', {
						type: 'button', style: C.mini,
						onClick: () => {
							if (draftId || preset.theme) {
								if (!window.confirm('会清空左侧所有字段和右侧预览，开始一篇新的。\n\n当前这篇的稿子不会丢，还在「我的创作」里。确认？')) return
							}
							newCompose()
						}
					}, '＋ 新建创作')),
				editing
					? h('div', { style: C.rightBody }, editorView)
					: h('div', { style: C.rightBody },
						booting
							? h('div', { style: C.empty }, h('div', { style: C.hint }, '读取中…'))
							: !draftId ? emptyView
								: done ? previewView : progressView))

			const left = h('div', { style: C.left },
				h(DraftConfig, {
					// key 变化时重建：从「空白」切到「回显某篇稿」时，
					// DraftConfig 内部的 useState 初始值才会重算。
					key: 'cfg-' + (preset.draftId || 'new') + '-' + newSeq,
					preset: preset,
					inline: true,
					onStart: onStart,
					onClose: () => { if (props.onCloseCompose) props.onCloseCompose() },
					onToast: props.onToast
				}))

			return h('div', { style: C.page }, left, right)
		}

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

		/**
		 * 从草稿行里取「标题复核候选」。
		 *
		 * 数据来源：写稿第⑧步发现标题不贴题时，Agent 把 3 个新候选写进
		 * `topics.titles_json` 的 `retitle` 字段（workbench-db 的 DRAFT_SELECT
		 * 把整份 titles_json 以 topic_titles_json 带出来了）。
		 *
		 * 为什么要 try：titles_json 是历史自由字段，早期存的是纯数组，
		 * 新版存 {candidates:[], retitle:[]}，还有可能是坏 JSON。
		 * 解析失败就当没有候选 —— **不能让一个标题字段把整张表搞崩**。
		 */
		function retitleCandidates(row) {
			const raw = row && row.topic_titles_json
			if (!raw) return []
			let d
			try { d = JSON.parse(raw) } catch (e) { return [] }
			const list = Array.isArray(d) ? [] : (d && d.retitle)
			if (!Array.isArray(list)) return []
			return list.filter((x) => x && (x.title || typeof x === 'string'))
		}

		/**
		 * 把还没配图的 `<img src="placeholder">` 换成占位框。
		 *
		 * 为什么要在前端做：`finalize.py` 在「图位已插、图还没生成」时会保留
		 * `src="placeholder"`（这是它的正常行为，不是 bug）。但浏览器拿到这种 src
		 * 会显示一个**破图图标**，看着像坏了，其实只是还没配图。
		 *
		 * 换成带 alt 文字的虚线框，用户一眼就知道「这里等着放图」，而且能读到
		 * 这一格本来要画什么（alt 就是画面描述）。
		 */
		function placeholderToBox(html) {
			const s = String(html || '')
			if (s.indexOf('src="placeholder"') < 0) return s
			return s.replace(/<img([^>]*?)src="placeholder"([^>]*?)>/g, (mm, a, b) => {
				// alt 里就是这一格的画面描述，取出来显示
				const m = /alt="([^"]*)"/.exec(a + b)
				const desc = m ? m[1] : ''
				return '<div class="wb-ph-box">🖼 待配图' +
					(desc ? '：' + desc : '') + '</div>'
			})
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
				// 墨鱼站在当前阶段块上方时左移半个身体宽度，让它的中心对准块中心
				// 26 → 34：和创作台一样，小尺寸下表情看不清。
				// 这一列宽度有限，34 是不压到相邻阶段块的上限。
				const WALKER_W = 34
				const SEG_W = 12, CUR_W = 18, GAP = 3
				let segLeft = 0
				for (let i = 0; i < cur; i++) segLeft += SEG_W + GAP
				const walkerLeft = segLeft + CUR_W / 2 - WALKER_W / 2
				// 阶段进度换算成百分比，用同一套表情规则（见创作台的 moodOf）
				const stagePct = cur >= 0 ? Math.round(((cur + 1) / DRAFT_STAGES.length) * 100) : 0
				const stageMood = stale ? 'sleep'
					: done ? 'cheer'
						: stagePct >= 70 ? 'star'
							: stagePct >= 35 ? 'happy' : 'focused'
				return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
					// 步骤条 + 站在当前阶段上的墨鱼
					h('div', {
						style: { position: 'relative', display: 'flex', alignItems: 'center', gap: GAP + 'px', minHeight: '34px', paddingTop: '26px' },
						title: DRAFT_STAGES.map((s, i) => (i <= cur ? '✓ ' : '· ') + DRAFT_LABEL[s]).join('\n')
					},
						// 墨鱼：只在「进行中」时跳舞，其余状态安静站着。
						// 全都动起来就分不出哪篇在跑了 —— 动 = 有任务在推进。
						cur >= 0
							? h('span', {
								style: {
									position: 'absolute', bottom: '9px', left: walkerLeft + 'px',
									width: WALKER_W + 'px', height: WALKER_W + 'px',
									// 换阶段时滑过去，带一点回弹
									transition: 'left .38s cubic-bezier(.34,1.3,.64,1)'
								}
							}, h(MoyuMascot, {
								size: WALKER_W,
								mood: stageMood,
								dance: running && !stale && !done,
								stale: !!stale
							}))
							: null,
						DRAFT_STAGES.map((st, i) => {
							const passed = i < cur
							const current = i === cur
							return h('span', {
								key: st,
								style: {
									width: current ? CUR_W + 'px' : SEG_W + 'px',
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
						h('h1', { style: S.h1 }, '我的创作'),
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
								'· 或到「选题库」点【去创作】，把选题带进创作配置。'),
							h('div', { style: { marginTop: '6px' } },
								'两条路都会先停在「创作配置」，点【开始创作】才真正动笔。'))
						: h('div', { style: S.wrap },
							h('table', { style: S.table },
								h('thead', null, h('tr', null,
									// 列宽按「谁最重要」排：标题撑满剩余空间，其余能一眼扫到就行。
									// 表头一律 nowrap，列宽才有稳定参考，不会因标题长而抖。
									h('th', { style: Object.assign({}, S.th, S.num, { width: '46px' }) }, 'id'),
									h('th', { style: Object.assign({}, S.th, { width: '76px', whiteSpace: 'nowrap' }) }, '封面'),
									h('th', { style: Object.assign({}, S.th, { minWidth: '320px' }) }, '标题'),
									h('th', { style: Object.assign({}, S.th, { width: '150px', whiteSpace: 'nowrap' }) }, '来源选题'),
									h('th', { style: Object.assign({}, S.th, { width: '84px', whiteSpace: 'nowrap' }) }, '赛道'),
									h('th', { style: Object.assign({}, S.th, { width: '150px', whiteSpace: 'nowrap' }) }, '写作技能'),
									h('th', { style: Object.assign({}, S.th, { width: '60px', whiteSpace: 'nowrap' }) }, '字数'),
									// 创建时间（2026-11-19 加）：按时间找稿子比按 id 直观。
									// id 会因历史测试数据跳号（9000 段），不能拿来当时间线索。
									h('th', { style: Object.assign({}, S.th, { width: '116px', whiteSpace: 'nowrap' }) }, '创建时间'),
									h('th', { style: Object.assign({}, S.th, { width: '150px', whiteSpace: 'nowrap' }) }, '创作进度'),
									h('th', { style: Object.assign({}, S.th, { whiteSpace: 'nowrap' }) }, '操作'))),
								h('tbody', null, drafts.map((r) => h('tr', { key: 'd' + r.id },
									h('td', { style: Object.assign({}, S.td, S.num) }, r.id),
									// 封面：有图就显示缩略图，没图显示占位。
									// 路径走 /api/workbench/asset，相对路径基于草稿目录。
									h('td', { style: S.td }, r.cover
										? h('img', {
											src: coverUrl(r),
											style: D.thumbImg,
											alt: '封面',
											title: (r.title || '') + '　（点击放大）',
											loading: 'lazy',
											onClick: () => {
												const zoom = props.onZoomCover
												if (typeof zoom === 'function') {
													zoom(
														coverUrl(r),
														r.title || '',
														(r.words ? r.words + ' 字' : '') + (r.skill ? '　·　' + r.skill : '')
													)
												}
											}
										})
										: h('div', { style: D.thumbEmpty }, '无封面')),
									// 标题是这页的主信息，给足宽度；行高收紧，两行内读完。
									// 写稿第⑧步复核出的候选（retitle）挂在这里：**只提示不自动改**，
									// 点一下才替换 —— 标题是主观判断，机器不该替用户决定。
									h('td', {
										style: Object.assign({}, S.td, {
											whiteSpace: 'normal',
											wordBreak: 'break-word',
											lineHeight: '1.45',
											fontWeight: 560,
											minWidth: '320px'
										})
									},
										h('div', null, r.title || '（未命名）'),
										(() => {
											const cands = retitleCandidates(r)
											if (!cands.length) return null
											return h('div', { style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '3px' } },
												h('div', { style: { fontSize: '10.5px', color: '#b54708', fontWeight: 600 } },
													'⚠ 标题待复核（' + cands.length + ' 个新候选，点一个替换）'),
												cands.map((c, i) => h('button', {
													key: 'rt' + i, type: 'button',
													style: {
														textAlign: 'left', padding: '3px 8px', borderRadius: '6px',
														border: '1px dashed color-mix(in srgb, #b54708 45%, transparent)',
														background: 'transparent', color: 'inherit',
														font: 'inherit', fontSize: '11.5px', fontWeight: 400,
														cursor: 'pointer', lineHeight: '1.45'
													},
													title: '点击用这一条替换当前标题',
													onClick: () => props.onPickTitle && props.onPickTitle(r, c)
												}, '· ' + (c.title || c)))) 
										})()),
									h('td', { style: Object.assign({}, S.td, { maxWidth: '150px', whiteSpace: 'nowrap' }) },
										(() => {
											// 「来源」：草稿没挂采集素材时退回选题标题或主题，
											// 不然这一列大半是空的（topics 64 条，topic_jobs 只有 3 条）。
											const st = sourceTextOf(r)
											if (!st) return h('span', { style: S.mono }, '—')
											const isTheme = (r.source_kind === 'theme')
											return h('span', {
												title: isTheme ? '这条没有挂采集素材，显示的是主题' : st,
												style: isTheme
													? { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis',
														whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' }
													: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
											}, st)
										})()),
									// 赛道列：二级垂类 + 它的上级（小字）。
									// 只显示二级名的话，用户看不出「娱乐」和「情绪心理」是一大类，
									// 也记不住 15 个各自归哪 —— 带上上级才成体系。
									h('td', { style: Object.assign({}, S.td, { whiteSpace: 'nowrap' }) },
										r.track
											? h('div', null,
												h('div', null, r.track),
												trackParent(r.track)
													? h('div', {
														style: {
															fontSize: '10px', marginTop: '2px', opacity: 0.5,
															whiteSpace: 'nowrap'
														}
													}, trackParent(r.track))
													: null)
											: '—'),
									h('td', { style: S.td },
										h('div', null, r.skill || '—'),
										h('span', {
											style: Object.assign({}, S.tag, { fontSize: '10px', marginTop: '3px' }),
											title: r.skill_class === 'A' ? 'A 类：遵守 aws 配额，下游可自动跑' : 'B 类：保留文风，但过不了 aws 配额门禁'
										}, (r.skill_class || '?') + ' 类')),
									h('td', { style: Object.assign({}, S.td, S.mono, { whiteSpace: 'nowrap' }) }, r.word_count || '—'),
									// 创建时间：只显示 月-日 时:分，年份在同一批稿子里通常是同一个。
									// 完整时间放 title 里，悬停能看。
									h('td', {
										style: Object.assign({}, S.td, S.mono, {
											whiteSpace: 'nowrap', fontSize: '11.5px',
											color: 'var(--dsw-alias-label-secondary)'
										}),
										title: r.created_at || ''
									}, (() => {
										const t = String(r.created_at || '')
										// 库里存的是 "2026-11-19 07:29:23"，取 "11-19 07:29"
										const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
										return m ? (m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : (t ? t.slice(0, 16) : '—')
									})()),
									h('td', { style: S.td }, stageProgress(r, runningId === r.id, isStale(r))),
									h('td', { style: S.td },
										// 操作列用 flex 分组：主操作在前、次要操作收在右侧小格里。
										// 整组不换行——以前靠 marginLeft 排，列一窄就折行，
										// 第二行只剩一个蓝按钮挂着，很难看。
										h('div', { style: S.draftActions },
										h('button', { style: S.mini, type: 'button', onClick: () => props.onPreview(r) }, '全文'),
										// 编辑 = 带着这篇的配置跳到创作台（左配置右预览），不是开弹窗。
										h('button', {
											style: Object.assign({}, S.mini, { marginLeft: '6px' }), type: 'button',
											disabled: !!props.busy,
											onClick: () => props.onEdit && props.onEdit(r)
										}, '编辑'),
										h('button', {
											style: Object.assign({}, S.mini, { marginLeft: '6px' }), type: 'button',
											onClick: () => props.onOpen(r)
										}, '详情'),
										// 制作封面：跳到绘图台，把这篇关联好。
										// 为什么单独一个按钮而不是复用「配图」：
										//   配图是「封面 + 4-6 张正文图」整组重做，要花一次完整额度；
										//   这里只是「想要一张封面」，走绘图台可以挑风格/图型慢慢调，
										//   而且封面单张更便宜。两件事的意图和成本都不一样。
										// 没封面的稿子标成主色（那是它最缺的东西），已有封面的降为普通按钮。
										h('button', {
											style: Object.assign({}, S.mini, { marginLeft: '6px' },
												r.cover ? null : {
													background: '#0b6bcb', color: '#fff',
													borderColor: '#0b6bcb', fontWeight: 650
												}),
											type: 'button',
											disabled: !!props.busy,
											title: r.cover
												? '去绘图台重做这篇的封面（当前已有封面）'
												: '去绘图台做这篇的封面，会自动关联这篇文章',
											onClick: () => props.onMakeCover && props.onMakeCover(r)
										}, r.cover ? '换封面' : '制作封面'),
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
										}, '移除'))))))))
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
							h('div', { style: D.v }, sourceTextOf(sel) || '（无来源）'),
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
						? h('div', { style: S.placeholder }, '还没有发布记录。到「我的创作」把稿子推进到「已配图」，再点【入草稿箱】。')
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
										(() => {
											// 「来源」：草稿没挂采集素材时退回选题标题或主题，
											// 不然这一列大半是空的（topics 64 条，topic_jobs 只有 3 条）。
											const st = sourceTextOf(r)
											if (!st) return h('span', { style: S.mono }, '—')
											const isTheme = (r.source_kind === 'theme')
											return h('span', {
												title: isTheme ? '这条没有挂采集素材，显示的是主题' : st,
												style: isTheme
													? { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis',
														whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' }
													: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
											}, st)
										})()),
									h('td', { style: S.td }, r.track || '—'),
									h('td', { style: S.td }, r.account || '—'),
									h('td', { style: S.td }, h('span', { style: S.tag }, PUB_METHOD[r.method] || r.method || '—')),
									h('td', { style: S.td }, h('span', { style: S.tag }, PUB_STATUS[r.status] || r.status || '—')),
									h('td', { style: Object.assign({}, S.td, S.mono) }, (r.created_at || '').slice(5, 16)),
									h('td', { style: S.td },
										// 发布记录操作列。
										// 「查看全文」：点开是**读这篇文章的正文**，不是看这条上传记录的元数据。
										// 之前叫「查看文章详情」但实际打开的是元数据抽屉，名不符实。
										// 现在走 onViewArticle → 复用「全文」窗口。
										h('button', {
											style: S.mini, type: 'button',
											disabled: !r.draft_id,
											title: r.draft_id ? '打开这篇文章的全文' : '这条记录没有关联草稿，看不到正文',
											onClick: () => props.onViewArticle && props.onViewArticle(r)
										}, '查看全文'),
									))))))
				),

				sel ? h('div', { style: S.drawer },
					h('button', { style: S.close, type: 'button', onClick: () => props.onOpen(null), title: '关闭' }, '✕'),
					h('div', { style: S.drawerHead },
						h('h2', { style: { margin: 0, fontSize: '16.5px', fontWeight: 650 } }, sel.draft_title || ('草稿 #' + sel.draft_id)),
						sel.draft_id ? h('button', {
							style: Object.assign({}, S.mini, { marginTop: '8px' }),
							type: 'button',
							onClick: () => props.onViewArticle && props.onViewArticle(sel)
						}, '查看全文') : null,
						h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
							h('span', { style: S.tag }, PUB_METHOD[sel.method] || sel.method || '—'),
							h('span', { style: S.tag }, PUB_STATUS[sel.status] || sel.status || '—'),
							h('span', { style: S.tag }, sel.account || '未记账号'))),
					h('div', { style: S.drawerBody },
						h('div', { style: S.block },
							h('div', { style: S.blockTitle }, '来源'),
							h('div', { style: M.v }, sourceTextOf(sel) || '（无来源）'),
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
			// 默认模块清单（props.modules 没传时才用）。
			// **不含「设置」**：设置已经提到外层 AppShell 顶部的一级 Tab 上，
			// 各子工作台里不该再有同一个入口 —— 两处都能进同一个页，
			// 用户会困惑「这两个设置有什么区别」，而且侧边栏会多出一条无用项。
			const MODULES = (props && props.modules) ||
				['漫图创作', '风格库', '图型库', '主色调', '角色资产库', '我的创作', '技能包']
			const [mod, setMod] = React.useState(MODULES[0])
			// 二级菜单展开状态（与 AppView 同一套 renderModMenu，见 menuForModules）
			const [menuOpen, setMenuOpen] = React.useState('')
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
			// ── 从文章拆解（封面 / 配图）──
			// drafts 只能在这里取：ImageStudio 是 makeApp 单独挂的一个视图，
			// AppView 的 drafts state 传不进来（它是另一个组件的内部状态）。
			const [drafts, setDrafts] = React.useState([])
			const [pickDraft, setPickDraft] = React.useState('')
			const [briefBusy, setBriefBusy] = React.useState(false)
			// 封面拆出来的多个候选（3 个不同角度）。点一个才写进主题框 ——
			// 直接塞最后一个等于替用户做了「哪句更适合当封面」这个判断，
			// 而这恰恰是他最想自己看一遍的地方。
			const [coverOpts, setCoverOpts] = React.useState([])
			// 选文章的弹窗（列表单选 + 按标题查 + 分页）。
			// 原来是个 <select>：文章一多就要滚很久，而且看不到封面和赛道，
			// 选错了得先选完才发现。
			const [draftPicker, setDraftPicker] = React.useState(false)
			const [draftQ, setDraftQ] = React.useState('')
			const [draftPage, setDraftPage] = React.useState(1)
			// 已经拆过的草稿 id。用来在换了文章之后提示「拆解结果还是上一篇的」——
			// 拆解结果直接写进主题框，用户很容易改完文章忘了再拆一次。
			const [briefFrom, setBriefFrom] = React.useState('')

			// ── 接收「从我的创作点制作封面」的跳转（2026-11-18）──
			//
			// 宿主的 selectPanel 没有参数通道，所以上一页把意图写进 JumpIntent 邮箱，
			// 这里挂载时读走。**必须清空**（JumpIntent.take 负责）——
			// 不清的话用户下次自己手动进绘图台，会莫名其妙又关联上上次那篇。
			//
			// 只在挂载时读一次：用户之后在本页改选文章，不该被这条意图覆盖回去。
			React.useEffect(() => {
				const it = JumpIntent.take('image')
				if (!it) return
				// 切到「文章封面」模式：意图是「做封面」，不是「随便画一张」。
				// 只设 pickDraft 不设 outMode 的话，用户进来看到的是纯图模式，
				// 关联了文章却没进入封面路径，还得自己再点一次模式。
				if (it.mod) setMod(it.mod)
				setOutMode('article-cover')
				setPickDraft(it.draftId)
				setBriefFrom('')
				setCoverOpts([])
				// flash 在本组件后面才定义（const，有 TDZ），所以延迟到下一轮事件循环。
				// 用 setTimeout 而不是直接调用：直接调会踩暂时性死区，整个面板白屏。
				setTimeout(() => flash('已关联文章 #' + it.draftId + '，点「一键拆解封面」开始'), 60)
			}, [])
			const previewBusy = !!(previewJobId && jobs.some((j) => j.id === previewJobId
				&& (j.status === 'queued' || j.status === 'running')))
			React.useEffect(() => {
				if (!previewBusy) return undefined
				const t = window.setInterval(() => setPreviewTick((x) => x + 1), 1000)
				return () => window.clearInterval(t)
			}, [previewBusy])

			const flash = (m) => { setToast(m); window.setTimeout(() => setToast(''), 2600) }

			// 文章列表：只在「文章封面 / 文章插图」两种模式下需要，进面板时取一次。
			// 不复用 AppView 的 drafts —— 那是另一个组件的 state，ImageStudio 是独立视图。
			const reloadDrafts = React.useCallback(async () => {
				try {
					const d = await apiGet('/api/workbench/drafts')
					setDrafts(Array.isArray(d.drafts) ? d.drafts : [])
				} catch { /* 取不到就当没有文章可选，不影响普通出图 */ }
			}, [])
			React.useEffect(() => { reloadDrafts() }, [reloadDrafts])

			// 只列**正文已经生成完**的稿子（formatted 及之后）。
			// 配图/封面本来就能重做多版，所以「已配过图」不设门槛；
			// 排除的只是还没定稿的那几档 —— 那时正文还会改，现在做的封面改完就不作数了。
			// 判据与后端 articleReady 保持一致（状态是单向推进的，按「formatted 之后」判）。
			const ARTICLE_READY_STAGES = ['formatted', 'illustrated', 'draftbox', 'published']
			const pickDrafts = drafts.filter((d) =>
				ARTICLE_READY_STAGES.indexOf(String(d.status || '')) >= 0)

			// 草稿阶段的中文名。和 IS_STATUS_ZH（生图任务状态）不是一回事，
			// 前者是草稿流程（formatted/illustrated…），后者是图片任务（queued/running…），
			// 混用会把 illustrated 显示成空。
			const DRAFT_STAGE_ZH = {
				queued: '排队中', draft: '初稿', polished: '已打磨', reviewed: '已审稿',
				formatted: '已排版', illustrated: '已配图', draftbox: '草稿箱', published: '已发布'
			}

			// 弹窗列表：按标题查（也匹配 id，改稿时常常只记得编号）
			const DRAFT_PAGE_SIZE = 8
			const draftQTrim = draftQ.trim().toLowerCase()
			const draftFiltered = draftQTrim
				? pickDrafts.filter((d) =>
					String(d.title || '').toLowerCase().includes(draftQTrim)
					|| String(d.id) === draftQTrim
					|| ('#' + d.id) === draftQTrim)
				: pickDrafts
			const draftPages = Math.max(1, Math.ceil(draftFiltered.length / DRAFT_PAGE_SIZE))
			// 搜出新结果时把页码拉回范围：不然停在空白的第 3 页，看起来像没搜到
			const draftPageSafe = Math.min(draftPage, draftPages)
			const draftRows = draftFiltered.slice(
				(draftPageSafe - 1) * DRAFT_PAGE_SIZE, draftPageSafe * DRAFT_PAGE_SIZE)
			const pickedDraftObj = pickDrafts.find((d) => String(d.id) === String(pickDraft)) || null

			// 拆解完成后把「分镜数」同步成实际拆出的镜数。
			//
			// 为什么必须同步：分镜数是**提交时的真实依据**（create 会按它决定拆几镜），
			// 而拆解给出的是内容的实际镜数。两者不一致时，用户看到裂板上是 4 镜，
			// 提交却按「自动」再算一遍 —— 可能变成 6 镜，预览与实出对不上。
			// 而且「自动」这个状态在拆完之后就不该保留了：内容已经确定，镜数也该确定。
			//
			// 注意 settle 一下：produced 可能是 0（内容太短拆不出），那就保持原样不动，
			// 不要把分镜数设成 0（0 在语义上是「自动」，会悄悄改变下次拆解的行为）。
			//
			// **必须定义在所有使用点之前**：const 有暂时性死区，
			// 声明前访问会抛 ReferenceError，整个面板白屏（check-tdz.py 会报）。
			const syncPanelCount = (produced) => {
				const n = Number(produced) || 0
				if (n > 0) setPanelCount(Math.min(24, n))
			}

			// 封面拆解：结果直接写进主题框（或候选列表），写完由用户自己点生成。
			const doArticleBrief = async (smart) => {
				const id = String(pickDraft || '')
				if (!id) { flash('先选一篇文章'); return }
				setBriefBusy(true)
				try {
					if (outMode === 'article-illustration') {
						// 配图：选文章 → 自动拆 N 个分镜，走 series 那条多图链路。
						// 有草稿就交给服务端读正文（draftId），不用把整篇塞进请求体。
						const d = await apiPost('/api/workbench/image-series',
							{ action: 'preview', draftId: id, count: panelCount, smart: !!smart })
						if (!d.ok) throw new Error(d.error || '拆解失败')
						const ps = d.panels || []
						setSeriesPreview(d)
						setSmartPanels(ps)
						setSmartDialogues(d.dialogues || [])
						setSmartNotes(d.notes || [])
						setSmartCast(d.cast || [])
						// 主题框也填一份：单图模式下它是「画面主题与内容」，
						// 分镜模式下它是「漫画文案（按空行分段）」—— 每镜一段正好就是它要的格式。
						setSourceText(ps.join('\n\n'))
						setBriefFrom(id)
						const m = d.meta || {}
						// 拆完就把镜数定下来 —— 否则「分镜数」还停在「自动」，
						// 用户得手动点加减号改，而且提交时会按「自动」重算，跟刚拆的对不上。
						syncPanelCount(ps.length || m.produced)
						flash('拆出 ' + ps.length + ' 个分镜，已写入下方文案框' +
							(m.short ? '（想更多用「AI 智能分镜」）' : ''))
					} else {
						// 封面：读整篇 → 3 个不同角度的画面 → 列出来让用户点一个。
						// **不自动填进主题框**：选哪句是创作判断，替他选了，
						// 后面出图不满意就说不清是模型画得差还是选题材选歪了。
						const d = await apiPost('/api/workbench/image-jobs',
							{ action: 'article-brief', draftId: id })
						if (!d.ok) throw new Error(d.error || '拆解失败')
						const opts = Array.isArray(d.options) ? d.options.filter(Boolean) : []
						setCoverOpts(opts)
						setBriefFrom(id)
						flash('已按《' + (d.title || '这篇文章') + '》拆出 ' + opts.length +
							' 个封面方案，点一个填进主题框')
					}
				} catch (e) { flash(String((e && e.message) || e)) }
				finally { setBriefBusy(false) }
			}
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
					// 拆完就把镜数定下来（见 syncPanelCount 的说明）
					syncPanelCount(m.produced)
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

			/**
			 * 出一组图（漫画流 / 电商多图 / 文章插图共用同一套「多图」链路）。
			 *
			 * 文章插图在这里合流而不是另开一条：拆出来的分镜、人物锚点、
			 * 并发出图、系列进度都是同一套东西，复制一份只会让两边慢慢走偏。
			 * 差别只有两点 —— 出处是某篇文章（draftId），以及出完要不要回写正文。
			 */
			const doComic = async () => {
				if (!styleReady) { flash('先选一个风格'); goTab('风格库'); return }
				const isArticle = outMode === 'article-illustration'
				// 文章插图模式下文案来源是那篇文章，不是手贴的框 —— 两处都认，
				// 但报错要说清该补哪个，不能一律「先贴漫画文案」。
				if (!isArticle && !sourceText.trim()) { flash('先贴漫画文案'); return }
				if (isArticle && !pickDraft && !smartPanels.length) {
					flash('先在「关联文章」里选一篇文章，点「一键拆分镜」')
					return
				}
				setBusy(true)
				try {
					// 有 AI 拆好的分镜就**显式传过去**，而不是让服务端再拆一次：
					// 再拆一次会得到不同的一版，预览与实出对不上。
					const base = isArticle
						? Object.assign({}, genPayload(), {
							// 文章插图：出处交给服务端读正文，不把整篇塞进请求体
							draftId: String(pickDraft || ''),
							illustrationWriteBack: true
						})
						: genPayload()
					const body = smartPanels.length
						? Object.assign({ action: 'create', count: smartPanels.length,
							// 原文一并带上：分镜虽已拆好，但原文是这一组图的出处，
							// 系列记录要留；电商多图那条路也是这么发的（sourceText + panels）。
							// 文章插图不传 —— 服务端按 draftId 读正文，重复传会撞命令行长度上限。
							sourceText: isArticle ? '' : sourceText,
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
							})) }, base)
						: Object.assign({ action: 'create', sourceText, count: panelCount }, base)
					const created = await apiPost('/api/workbench/image-series', body)
					if (!created.ok) throw new Error(created.error || '创建失败')
					const run = await apiPost('/api/workbench/image-series',
						{ action: 'run', seriesId: created.seriesId })
					if (!run.ok) throw new Error(run.error || '启动失败')
					// 并发出图（2026-11-16）：多镜不再一张一张排队，同时跑几路由设置页
					// 「批量出图并发数」决定（默认 3）。这里说清楚，用户看到进度是跳着来的不会以为出错。
					// 文章插图会**整组出完后自动回写正文**（见 run_series 末尾），
					// 所以提示里直接说明，免得用户以为还要再点一次。
					flash('已开始生成 ' + created.panelCount + (isArticle ? ' 张插图' : ' 镜') +
						'（一组 ' + created.panelCount + ' 张，按张计费；并发出图，进度会跳着完成'
						+ (isArticle ? '；整组出完会自动回写到文章，已有配图直接替换' : '') + '）')
					await reloadSeries()
					await reload()
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally { setBusy(false) }
			}

			// 插图回写（**手动兜底**，正常不需要点）。
			// 整组出完时 run_series 会自动回写；这个按钮留着是为了两种情况：
			//   · 出图时草稿被改过、自动回写被跳过，想手动补一次；
			//   · 想用正文现有占位符重新对齐一遍。
			// 它同样会替换已有配图（img-* 先清后写 + finalize 覆盖 article.md），
			// 所以重复点不会产生重复图。
			const doIllustrateWriteBack = async () => {
				const id = String(pickDraft || '')
				if (!id) { flash('先选一篇文章'); return }
				setBusy(true)
				try {
					const r = await apiPost('/api/workbench/image-series',
						{ action: 'illustrate-writeback', draftId: id })
					if (!r.ok) throw new Error(r.error || '回写失败')
					flash('已把 ' + r.inserted + ' 张插图写回正文并重排版')
					await reloadDrafts()
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
					withRef,
					// 选了文章才带 draftId。只有「文章封面」模式才让服务端回写 ——
					// 配图是一组图，回写到正文靠 finalize.py 的占位符替换，不是这里的事。
					draftId: pickDraft ? String(pickDraft) : '',
					coverWriteBack: !!(pickDraft && outMode === 'article-cover')
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
						created.panelCount + ' 张按张计费；多图并发出图，进度会跳着完成）')
					await reloadSeries()
					await reload()
				} catch (e) {
					flash(String((e && e.message) || e))
				} finally { setBusy(false) }
			}
			// 漫画流 / 电商详情页多图 / 文章插图共用右侧的「分镜板」
			const batchMode = createMode === 'comic'
				|| (outMode === 'ecommerce' && ecMulti)
				|| outMode === 'article-illustration'

			// 主题框此刻编辑的是哪个字段：sourceText（一串分镜/文案）还是 theme（单张画面的主题）。
			//
			// 判断依据不是 createMode，而是**这个模式在提交时读哪个字段**：
			//   · 漫画流、文章插图 → 走 doComic 多图链路，读 sourceText
			//   · 其余（纯图/图文/海报/封面/摄影/电商单图）→ 读 theme
			// 之前只判 `createMode === 'comic'`，于是「文章插图」的拆解结果
			// 写进了 sourceText，而输入框还绑着 theme —— 框里永远是空的（实测反馈）。
			// 凡是「拆完要回填」的功能，都必须认这一个判据，不能再各自写条件。
			const usesTextbox = createMode === 'comic' || outMode === 'article-illustration'

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
				// **文章插图：一组多图** —— 选一篇文章拆 N 个分镜，每个分镜出一张。
				// 原来它落到下面的单图分支，而配图拆解把分镜写进了 sourceText，
				// 单图分支读的是 theme → 「sourceText required」/「先填画面主题」来回报错。
				// 配图的语义本来就是「给这篇文章配一组图」，不该是一次一口气。
				if (outMode === 'article-illustration') { await doComic(); return }
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

					sec('2', [Req(), outMode === 'article-illustration' ? '插图画面（每段一镜）'
						: createMode === 'comic' ? '漫画文案（按空行分段）'
							: (outMode === 'ecommerce' ? '商品信息（越详细越准）' : '画面主题与内容')],
						h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
							(usesTextbox ? sourceText.length : theme.length) + ' / 3000'), [
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
						// 文章选择：只在「文章封面 / 文章插图」两种模式下出现。
						// 选了文章就能「一键拆解」—— 封面读全篇给一句画面描述；
						// 配图把整篇拆成 N 个分镜。拆完写进下面的框/分镜面板，**不出图**：
						// 拆解是给素材，出图是花钱，两件事不能合成一个按钮。
						(outMode === 'article-cover' || outMode === 'article-illustration')
							&& createMode !== 'comic'
							? h('div', { style: { marginBottom: '9px' } },
								h('div', { style: IS.rowWrap },
									h('span', { style: IS.label }, '关联文章'),
									// 用按钮开弹窗而不是 <select>：文章多了下拉要滚半天，
									// 而且看不到封面和赛道 —— 选完才发现选错，只能重来。
									h('button', {
										type: 'button',
										style: Object.assign({}, IS.select, {
											maxWidth: '460px', textAlign: 'left', cursor: 'pointer',
											display: 'inline-flex', alignItems: 'center', gap: '8px'
										}),
										onClick: () => { setDraftQ(''); setDraftPage(1); setDraftPicker(true) }
									},
										pickedDraftObj
											? (coverUrl(pickedDraftObj)
												? h('img', {
													src: coverUrl(pickedDraftObj), alt: '',
													style: {
														width: '42px', height: '24px', objectFit: 'cover',
														borderRadius: '4px', flex: '0 0 auto'
													}
												})
												: h('span', {
													style: {
														width: '42px', height: '24px', borderRadius: '4px',
														background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
														flex: '0 0 auto'
													}
												}))
											: null,
										h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
											pickedDraftObj
												? ('#' + pickedDraftObj.id + ' ' + (pickedDraftObj.title || '(无标题)'))
												: '— 点这里选一篇文章 —'),
										h('span', { style: { opacity: 0.5, flex: '0 0 auto' } }, '▾')),
									pickDraft
										? h('button', {
											type: 'button', style: S.mini,
											onClick: () => { setPickDraft(''); setBriefFrom(''); setCoverOpts([]) }
										}, '✕ 取消关联')
										: null,
									h('button', {
										type: 'button', style: S.mini, disabled: briefBusy || !pickDraft,
										onClick: () => doArticleBrief(outMode === 'article-illustration')
									}, briefBusy ? '拆解中…'
										: (outMode === 'article-illustration' ? '✨ 一键拆分镜' : '✨ 一键拆解封面')),
									// 插图回写：图出完之后才会成功，提前点会说「配图还没出完」
									outMode === 'article-illustration' && pickDraft
										? h('button', {
											type: 'button', style: S.mini, disabled: busy,
											onClick: doIllustrateWriteBack
										}, '↩ 重新回写正文')
										: null),
								h('div', { style: Object.assign({}, IS.meta, { marginTop: '5px' }) },
									outMode === 'article-illustration'
										? '选一篇文章 → 按整篇拆出几个分镜，自动填到下面；分镜数在下面调。'
										: '选一篇文章 → 通读全篇给 3 个封面方案，点一个填到下面；封面一律不写字。'),
								// 只列正文已完成的稿子，说明一句，免得用户找不到某篇文章以为坏了
								h('div', { style: Object.assign({}, IS.meta, { marginTop: '3px' }) },
									'可选 ' + pickDrafts.length + ' 篇正文已写完的文章；'
									+ '还没定稿的稿子正文还会改，暂不参与。'),
								// 封面候选：点一个才写进主题框
								coverOpts.length
									? h('div', { style: { marginTop: '8px' } },
										h('div', { style: { fontSize: '12px', fontWeight: 650, marginBottom: '6px' } },
											'选一个封面方案（点一下填进主题框）'),
										coverOpts.map((o, i) => h('button', {
											key: i, type: 'button',
											style: Object.assign({}, IS.pickCard, {
												display: 'block', width: '100%', textAlign: 'left',
												marginBottom: '6px', cursor: 'pointer'
											}),
											onClick: () => { setTheme(o); flash('已填入第 ' + (i + 1) + ' 个方案') }
										},
											h('span', { style: { fontSize: '11px', opacity: 0.65, marginRight: '7px' } },
												['主体动作', '物件特写', '环境全景'][i] || ('方案 ' + (i + 1))),
											h('span', null, o))))
									: null,
								// 拆完又换文章：主题框里还是上一篇的，必须说出来，
								// 否则用户会以为新文章已经拆过了。
								(pickDraft && briefFrom && briefFrom !== String(pickDraft))
									? h('div', { style: Object.assign({}, IS.meta, { marginTop: '5px', color: '#b54708' }) },
										'下面的内容是从 #' + briefFrom + ' 拆的，已换文章 —— 需要再点一次拆解。')
									: null,
								// 封面回写只对「选了文章」生效，说清楚写到哪，避免用户找不到图
								(pickDraft && outMode === 'article-cover')
									? h('div', { style: Object.assign({}, IS.meta, { marginTop: '5px' }) },
										'出图后自动回写为该文章封面（imgs/cover.png，已有则先备份为 cover.png.bak）')
									: null)
							: null,
						h('textarea', {
							style: Object.assign({}, S.textarea,
								usesTextbox ? { minHeight: '170px' }
									: (outMode === 'ecommerce' ? { minHeight: '140px' } : null)),
							value: usesTextbox ? sourceText : theme,
							maxLength: 3000,
							placeholder: usesTextbox
								? (outMode === 'article-illustration'
									? '选一篇文章点「一键拆分镜」，分镜会填到这里；也可以自己贴文案，按空行分段，每段一镜。'
									: '贴一段文章、一句话或一句金句。按空行分段 —— 每段默认就是一镜。')
								: outMode === 'ecommerce'
									? '例：316 不锈钢轻量保温杯，500ml，杯身磨砂，杯盖食品级 PP，24 小时保温，'
										+ '净重 280g，通勤/健身适用，四色可选。\n'
										+ '（越详细越准：规格给参数图、卖点给卖点图、场景给场景图 —— 点下面「怎么写」看全貌）'
									: '例：秋天的夕阳，一个人坐在河堤上看远处亮起的路灯',
							// 读写必须与 value 同一个判据：写错来源会让「改了框里的字但提交的还是旧的」
							onChange: (e) => (usesTextbox
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
						// 分镜数控件：凡是「一组多图」的模式都要能调（漫画流 / 电商多图 / 文章插图）。
						// 原来只对 comic 显示，于是文章插图拆完之后没法改镜数。
						batchMode
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
										(batchMode ? !(usesTextbox ? sourceText : theme).trim()
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

			// 「设置」已提到外层 AppShell 的切换条上，各子工作台不再有这一个模块。
			const view = mod === '技能包' ? h(SkillPack, { pack: 'image' })
				: curGal ? galleryView(curGal)
					: mod === ASSET_MOD ? assetLibView
						: mod === '漫图创作' ? studioView
							: assetView

			// 二级导航在左侧边栏（由 AppShell 摆位置，见 renderSideNav）。
			// sidebar 是 shell 通过 render-prop 传下来的渲染器；没传就退化成顶部横条，
			// 保证单独渲染 ImageStudio 时也不至于没有导航。
			const nav = props.sidebar
				? h('div', {
					style: {
						flex: '0 0 176px', minWidth: 0, overflowY: 'auto',
						padding: '14px 10px',
						borderRight: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)'
					}
				}, props.sidebar(MODULES, mod, goTab))
				: h('div', { style: S.tabs }, renderModMenu(MODULES, mod, goTab, menuOpen, setMenuOpen))
			return h('div', { style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } },
				nav,
				h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } },
				h('div', { style: S.page },
					// 状态提示条（风格/垫图/花费）留在页面顶部，它不属于导航
					h('div', { style: S.tabs },
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
			// 选文章弹窗：列表单选（序号 / 封面 / 标题 / 赛道 / 状态），按标题查，分页。
			// 表格用 h('table') 而不是把卡片堆起来 —— 这几列就是为了横着比，
			// 竖排卡片反而看不出「哪篇是哪篇」。
			draftPicker ? h('div', {
				style: IS.overlay,
				onClick: () => setDraftPicker(false)
			},
				h('div', {
					style: Object.assign({}, IS.overlayCard, {
						maxWidth: '980px', maxHeight: '88vh', display: 'flex', flexDirection: 'column'
					}),
					onClick: (e) => e.stopPropagation()
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '11px' } },
						h('span', { style: { fontWeight: 650, fontSize: '15px' } }, '选一篇文章'),
						h('span', { style: IS.meta }, '共 ' + draftFiltered.length + ' 篇'),
						h('button', {
							type: 'button', style: Object.assign({}, S.mini, { marginLeft: 'auto' }),
							onClick: () => setDraftPicker(false)
						}, '✕ 关闭')),
					h('div', { style: { marginBottom: '10px' } },
						h('input', {
							style: Object.assign({}, S.search, { marginTop: 0, width: '100%' }),
							value: draftQ,
							autoFocus: true,
							placeholder: '按标题搜索（也可以直接输编号，如 37）',
							onChange: (e) => { setDraftQ(e.target.value); setDraftPage(1) }
						})),
					h('div', { style: { flex: '1 1 auto', overflowY: 'auto' } },
						draftRows.length
							? h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' } },
								h('thead', null, h('tr', null,
									['序号', '封面', '标题', '赛道', '状态', ''].map((t, i) => h('th', {
										key: i,
										style: {
											textAlign: 'left', padding: '7px 9px', fontWeight: 650,
											position: 'sticky', top: 0, whiteSpace: 'nowrap',
											background: 'var(--dsw-alias-bg-primary, #fff)',
											borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)'
										}
									}, t)))),
								h('tbody', null, draftRows.map((d) => {
									const on = String(d.id) === String(pickDraft)
									return h('tr', {
										key: String(d.id),
										style: {
											cursor: 'pointer',
											background: on
												? 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)'
												: 'transparent'
										},
										onClick: () => {
											setPickDraft(String(d.id))
											setBriefFrom('')
											setCoverOpts([])
											setDraftPicker(false)
										}
									},
										h('td', { style: { padding: '7px 9px', opacity: 0.7, whiteSpace: 'nowrap' } }, '#' + d.id),
										h('td', { style: { padding: '5px 9px' } },
											coverUrl(d)
												? h('img', {
													src: coverUrl(d), alt: '',
													style: {
														width: '64px', height: '36px', objectFit: 'cover',
														borderRadius: '5px', display: 'block'
													}
												})
												: h('span', {
													style: Object.assign({}, IS.meta, { fontSize: '11px' })
												}, '无封面')),
										h('td', { style: { padding: '7px 9px', fontWeight: on ? 650 : 400 } },
											d.title || '(无标题)'),
										h('td', { style: { padding: '7px 9px', opacity: 0.75, whiteSpace: 'nowrap' } },
											d.track || '—'),
										h('td', { style: { padding: '7px 9px' } },
											h('span', { style: S.tag }, DRAFT_STAGE_ZH[d.status] || d.status)),
										h('td', { style: { padding: '7px 9px', whiteSpace: 'nowrap' } },
											on ? h('span', { style: { fontWeight: 650 } }, '✓ 已选') : null))
								})))
							: h('div', { style: Object.assign({}, IS.meta, { padding: '26px 0', textAlign: 'center' }) },
								draftQTrim ? '没有标题匹配「' + draftQ + '」的文章' : '还没有正文已写完的文章')),
					draftPages > 1
						? h('div', {
							style: {
								display: 'flex', alignItems: 'center', gap: '8px',
								justifyContent: 'center', paddingTop: '11px'
							}
						},
							h('button', {
								type: 'button', style: S.mini, disabled: draftPageSafe <= 1,
								onClick: () => setDraftPage(Math.max(1, draftPageSafe - 1))
							}, '‹ 上一页'),
							h('span', { style: IS.meta }, draftPageSafe + ' / ' + draftPages),
							h('button', {
								type: 'button', style: S.mini, disabled: draftPageSafe >= draftPages,
								onClick: () => setDraftPage(Math.min(draftPages, draftPageSafe + 1))
							}, '下一页 ›'))
						: null))
				: null,
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
					))    // 收 h('div', {style: S.page})
				)         // 收 h('div', {flexDirection:'column'})
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

		// 三个子工作台共用的外壳：顶部「公众号 / 绘图 / 技能库」切换条。
		// 每个子应用的 main 面板都套这一层，所以不管内部怎么渲染，切换条都在。

		// 「DSH 侧边栏是我收起的吗」—— 必须放在组件外（模块级），
		// 因为切子工作台会卸载并重新挂载 AppShell，放组件内每次都会被重置成 false，
		// 结果就是「每切一次就多收一次」，侧边栏再也打不开。
		const MoyuSidebar = { byMe: false }

		function AppShell(props) {
			const cur = props.currentKey
			// 「设置」不占一个子工作台，而是切换条上的第四个标签。
			// 它不属于 gzh / image / skills 任何一个，所以用单独的状态记住它。
			const [showSettings, setShowSettings] = React.useState(false)
			// 侧边栏的模块选中项**由 AppShell 持有**（2026-11-17 改布局时定的）：
			// 之前它在各工作台内部（AppView / ImageStudio 各自的 mod），
			// 侧边栏在它们外面就够不着了。提升到这里，各工作台改成受控
			// （props.mod / props.onMod），渲染逻辑不动。
			const curApp = APPS.find((a) => a.key === cur) || APPS[0]

			// ── 进墨鱼自动收起 DSH 侧边栏，离开自动恢复（2026-11-17 加）──
			//
			// 为什么需要自己记标记：宿主的 ctx.layout 只给 toggleSidebar()，
			// 是**纯开关**（service.ts: Toggle the sidebar panel closed ⟷ default width），
			// 既没有「设为收起」也没有读当前开合的公开方法 ——
			// 实际状态 layoutInfo.sidebar（宽度，0 = 收起）在 root store 里，ctx.layout 没暴露。
			// 所以「盲切」会把它本来已收起的反而展开。这里用模块级标记配对：
			//   · 只有我收的我才恢复，用户自己点宿主按钮收起的不会被掀开；
			//   · 收起/恢复各切一次，始终配对。
			// 已知局限：用户在墨鱼里用宿主自带按钮手动开合过侧边栏，标记会和实际错位
			// （表现：下次进出多切一次）。宿主不给读状态，这个错位从插件侧无法根除。
			React.useEffect(() => {
				const L = props.ctx && props.ctx.layout
				if (!L || typeof L.toggleSidebar !== 'function') return undefined
				// 本次挂载我到底切没切，用局部量记，清理函数只认它 ——
				// 比读全局标记更硬：即使别处把 MoyuSidebar.byMe 改掉了，
				// 也不会出现「没收过却去展开」或「收过却不恢复」。
				let iCollapsed = false
				if (!MoyuSidebar.byMe) {
					try {
						L.toggleSidebar()      // 收起
						MoyuSidebar.byMe = true
						iCollapsed = true
					} catch (err) { /* 宿主版本差异：静默跳过，不影响工作台本身 */ }
				}
				return () => {
					if (!iCollapsed) return
					const L2 = props.ctx && props.ctx.layout
					if (!L2 || typeof L2.toggleSidebar !== 'function') return
					try {
						L2.toggleSidebar()     // 展开回来
						MoyuSidebar.byMe = false
					} catch (err) { /* 同上 */ }
				}
			}, [props.ctx])

			return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
				h('div', { style: S.appTabs },
					APPS.map((a) => h('button', {
						key: 'app-' + a.key, type: 'button',
						style: Object.assign({}, S.appTab,
							(!showSettings && a.key === cur) ? S.appTabOn : null),
						// 内联样式写不了 :hover，用进出事件给未选中项一点颜色反馈。
						// 判定条件要与 onClick 一致：设置遮罩开着时，任何一个标签都不是
						// 「已选中」状态（连当前面板那个也不是，因为它被遮住了），
						// 所以都要给 hover 反馈，否则在设置页上这排标签看着全是死的。
						onMouseEnter: (ev) => {
							if (!showSettings && a.key === cur) return
							ev.currentTarget.style.color = 'var(--dsw-alias-label-primary)'
						},
						onMouseLeave: (ev) => {
							// 遮罩关掉后回到未选中色；遮罩开着就回默认灰
							if (!showSettings && a.key === cur) return
							ev.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'
						},
						onClick: () => {
							// 必须先关设置遮罩，再判「是不是同一个面板」。
							// 顺序反了会有一个死锁：cur 记的是**当前挂载的面板**，
							// 不是「当前显示什么」——打开设置不会换面板，cur 一直是 gzh。
							// 于是从设置页点「公众号」时 a.key === cur 成立，函数在这里
							// 直接 return，setShowSettings(false) 永远执行不到，界面卡死在设置页。
							setShowSettings(false)
							// 同一个面板：遮罩关掉就够了，不必再 selectPanel 一次
							if (a.key === cur) return
							// 切子工作台靠 ctx.layout.selectPanel(id)。
							// layout 是 @deepseek-ai/dsh-client-ui-layout 的服务，
							// 已在 inject 里声明，拿不到说明宿主版本不含这个插件。
							// 这种情况必须**说出来**，否则就是「点了没反应」——
							// 用户会以为是标签坏了，而不是环境缺服务。
							const L = props.ctx && props.ctx.layout
							if (!L || typeof L.selectPanel !== 'function') {
								window.alert(
									'切换不了：当前 DSH 没有提供 layout 服务。\n\n' +
									'它是 @deepseek-ai/dsh-client-ui-layout 提供的面板切换接口。\n' +
									'请确认这个插件已启用，或升级 DSH。')
								return
							}
							try {
								L.selectPanel(a.key)
							} catch (err) {
								window.alert('切换失败：' + String((err && err.message) || err))
							}
						}
					}, a.label)),
					// 设置放在最后一个：它是全局配置，不属于任何一个子工作台
					h('button', {
						key: 'app-settings', type: 'button',
						style: Object.assign({}, S.appTab, showSettings ? S.appTabOn : null),
						onMouseEnter: (ev) => {
							if (showSettings) return
							ev.currentTarget.style.color = 'var(--dsw-alias-label-primary)'
						},
						onMouseLeave: (ev) => {
							if (showSettings) return
							ev.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'
						},
						onClick: () => setShowSettings(true)
					}, '设置'),
					// 右上角：会动的墨鱼 + 工作台名。
					// LOGO 放**文字左边**而不是只放图：光一个图标在标签栏右端太孤立，
					// 配上名字才知道它代表什么（尤其第一次用的人）。
					h('span', {
						style: {
							marginLeft: 'auto', alignSelf: 'center', paddingRight: '18px',
							display: 'inline-flex', alignItems: 'center', gap: '7px',
							fontSize: '12px', color: 'var(--dsw-alias-label-secondary)'
						}
					},
						h(MoyuMascot, { size: 40 }),
						h('span', null, APP_GROUP.label))),
				// 设置面板盖住内容区；关掉（点任一子工作台标签）就回到原来的内容
				showSettings
					? h('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
						h(SettingsPanel, {
							groups: ['gzh', 'image'],
							onSaved: reloadSettings,
							ctx: props.ctx,
							onToast: props.onToast || function () {}
						}))
					// 内容区 = 左侧二级导航 + 右侧页面（2026-11-17 改布局）。
					//
					// 侧边栏渲染成 **render-prop**：模块选中项属于各工作台自己
					// （AppView / ImageStudio 各有一份 mod，改它们要动的代码多得多），
					// 所以由工作台把「侧边栏长什么样」交回来，外壳只负责摆位置。
					// 这样布局在外壳、状态在工作台，两边都不用互相穿透。
					: h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } },
						typeof props.children === 'function'
							? props.children({ sidebar: renderSideNav })
							: h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto' } },
								props.children)))
		}

		function makeApp(app, ctx) {
			// 生图工作台自成一体：它不读 topic_jobs/drafts 那套会话数据，
			// 只走 /api/workbench/image-* 那 5 条路由，所以直接返回自己的组件。
			if (app.key === 'image') {
				// 把模块清单传进去，界面里就不必再硬编码一遍 tab 顺序
				return function ImageStudioView() {
					// 包一层错误边界：渲染抛异常时不要再以"白屏"的形式结束
					// 用 render-prop 把侧边栏渲染器交给 ImageStudio：
					// 布局（左侧 176px 导航）由 shell 统一，模块状态仍归 ImageStudio。
					return h(AppShell, { currentKey: app.key, ctx: ctx },
						({ sidebar }) => h(PanelBoundary, null,
							h(ImageStudio, { modules: app.modules, sidebar })))
				}
			}
			// 顶层「技能库」是插件级入口，不绑定会话数据，也不加载 SQLite——
			// 它只读构建时扫出来的技能注册表。
			if (app.kind === 'registry') {
				return function RegistryView() {
					return h(AppShell, { currentKey: app.key, ctx: ctx },
						h('div', { style: S.page }, h(SkillLibrary)))
				}
			}
			return function AppView(props) {
				// 模块选中项由 AppShell 持有（左侧边栏在那儿），这里接收；
				// 没传就退回本地 state，保证单独渲染这个组件时也不会白屏。
				const [modLocal, setModLocal] = React.useState(app.modules[0])
				const mod = (props && props.mod !== undefined) ? props.mod : modLocal
				const setMod = (m) => setModLocal(m)
				// 二级菜单里当前展开着的那一组（label）。空 = 都收起。
				// 用 state 而不是纯 CSS :hover —— 收起时子项还要能点，
				// 纯 hover 一移开鼠标下拉就没了，点不到最后一项。
				const [menuOpen, setMenuOpen] = React.useState('')
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

			// 投递目标不再在这里探测。
			//
			// 老代码在这里维护一份 targetSession state 想「让用户看见指令会投给谁」，
			// 但它算出来的结果从来没渲染到任何地方（接给 HotRankLibrary 的两个 prop
			// 那个组件根本没读），是纯粹的死代码。
			// 现在「实际会投给谁」在设置面板那一行里显示，那里是用户配置的地方，
			// 看得见才有意义。

			// 启动时把设置读进 WORKBENCH_SETTINGS。
			// 以前 reloadSettings 只在「设置页保存后」被调用，
			// 首次进来 WORKBENCH_SETTINGS 是空对象，cfgBool 永远返回默认值——
			// 也就是说「骨架要人工确认」这个开关在第一次保存设置前根本不起作用。
			React.useEffect(() => { reloadSettings() }, [])

			// 手动改投递目标的那条 localStorage 路径已移除（2026-11-17）。
			// 现在只有「设置面板里配的会话」一个来源，配了就用配的、没配就用最近活跃，
			// 单一来源才不会出现「界面上选了一个、实际投给另一个」。

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
				// 创作台的输入：选题带进来的预设。
				// 与 draftCfg 分开：draftCfg 给弹窗用，composePreset 给常驻页面用。
				const [composePreset, setComposePreset] = React.useState(null)
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
					// 订阅赛道 / 取几条 从设置里读（见 init-settings.py 的 autoTopic*）。
					// 每次都现读：用户可能刚在设置页改完就回来点，缓存的旧值会让他以为没生效。
					let tracks = ''
					let wantCount = 1
					try {
						const r = await apiGet('/api/workbench/settings')
						const m = {}
						;((r && r.settings) || []).forEach((it) => { m[it.key] = it.value })
						tracks = String(m.topicTracks || '')
						const n = parseInt(m.autoTopicCount, 10)
						if (n > 0) wantCount = Math.min(10, n)
					} catch (e) { /* 读不到就用默认：不筛赛道、取 1 条 */ }
					if (!ctx || !ctx.remote || !ctx.remote.session) {
						flash('会话不可用：刷新页面后再试')
						return
					}
					flash(tracks
						? ('正在投递指令（赛道：' + tracks + '）…')
						: '正在投递指令…')
					try {
						await triggerAgent(ctx.remote, flash,
							dailyTopicPrompt(dateStr, tracks, wantCount))
						flash('已投递今日选题生成指令（' + wantCount + ' 条素材 × 2 方向'
							+ (tracks ? '，赛道：' + tracks : '') + '）')
					} catch (err) {
						const msg = String((err && err.message) || err)
						flash(msg.startsWith('COOLDOWN')
							? ('会话正在跑，' + (msg.split(':')[1] || '稍') + ' 秒后再点')
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

				// 选题库「去创作」→ **只打开创作配置**，不建草稿、不触发写作。
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

					// 2026-11-13：从「开弹窗」改成「切到创作台」。
					// 弹窗填完就关，写出来的东西要回列表再点开看；
					// 创作台是常驻页，左边配置右边预览，改字不用来回切。
					setComposePreset({
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
						// 带上赛道与技能，创作台要回显
						skill: topic.skill || '',
						// 结构类型带进配置，写作时 structureRulesText 会把它标成「本篇选它」
						structureType: topic.structure_type || '',
						topicRole: topic.topic_role || ''
					})
					// 直接切到创作台，让人看到左侧配置 + 右侧预览
					setMod('创作台')
				}

				// 手工「开始创作」→ 建草稿 → 触发写作。只有这里会真的开跑。
				// 配置里选了写作技能就按它写（skillClass 一起传，A/B 门禁不同）；
				// 没选就留空，让数据层兜底路由（老选题兼容）。
				const startDraft = async (cfg) => {
					setPending((p) => Object.assign({}, p, { draft: true, draftId: cfg.draftId || 'new' }))
					try {
						// 重新生成 = 新建一篇（2026-11-13 改）。
						//
						// 原来这里是「原地回写 + 清产出 + 让 Agent 重写」，
						// 但 Agent 写回是异步的，任何失败都留下空稿，
						// 加了备份和回滚也只是兜底，治不了根。
						//
						// 现在老稿一字不动，新稿另起一条，标题后缀「· 重写」。
						// 最坏情况只是新稿没生成，不影响已有内容。
						let res = null
						if (cfg.draftId) {
							const baseTitle = String(cfg.title || cfg.theme || '未命名').trim()
							res = await apiPost('/api/workbench/drafts', {
								action: 'create',
								topicId: cfg.topicId || null,
								// 标题加后缀，列表里能一眼分清哪篇是哪篇
								title: baseTitle + ' · 重写',
								theme: cfg.theme,
								materials: cfg.materials,
								requirement: cfg.requirement,
								viewpoint: cfg.thesis || cfg.requirement,
								track: cfg.genre,
								skill: cfg.skill,
								skillClass: cfg.skillClass,
								config: Object.assign({}, cfg.config || {}, {
									structureType: cfg.structureType || '',
									topicRole: cfg.topicRole || '',
									// 记下它是从哪一篇重写来的，方便对照
									rewriteOf: cfg.draftId
								})
							})
							if (!res || res.ok === false) {
								throw new Error((res && res.error) || '新建重写稿失败')
							}
						} else {
							// 没有 draftId = 全新创作（从「＋ 新建创作」或选题带过来的空配置）。
							// 这一支 2026-11-13 被我误删过，导致 res 恒为 null，
							// 后面 res.id 直接抛 Cannot read properties of null。
							res = await apiPost('/api/workbench/drafts', {
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
									structureType: cfg.structureType || '',
									topicRole: cfg.topicRole || ''
								})
							})
							if (!res || res.ok === false) {
								throw new Error((res && res.error) || '新建草稿失败')
							}
						}
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
							flash(msg.startsWith('COOLDOWN')
								? ('草稿已建：会话正在跑，' + (msg.split(':')[1] || '稍') + ' 秒后再点，或先停止那一轮')
								: '草稿已建，但触发写作失败：' + msg)
						}
						return res        // 返回新建结果（含 id），创作台靠它启动轮询
					} catch (err) {
						flash('建草稿失败：' + String((err && err.message) || err))
						return null
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
					// 2026-11-17 重写。旧版有三处硬伤，都是实测出来的：
					//
					// 1) **图位描述从来没传给 Agent**。旧版只说「按图位数生成」，
					//    Agent 只能把整篇文章当 theme 丢给模型。实测 #39 的
					//    image_jobs.theme 是 2912 字全文，模型面对议论文抓不到画面，
					//    吐出来的是快递纸箱和抽象立方体。现在由 article-images.py
					//    plan 把每个图位对应的一段正文（约 400 字）切好给它。
					//
					// 2) **「按 styleCode 决定配图策略」是死代码**。config_json 里的
					//    styleCode 是**写作**风格（如 MS-008 人格叙事体），跟画风
					//    没有关系，这一步选不出任何东西。改成 Agent 读全文自己选画风。
					//
					// 3) **imgs/prompts/ 全空**，18 篇已配图草稿无一例外，违反
					//    SKILL.md 第 147 行「先落 prompt 再生成」。现在由
					//    article-images.py write 强制落盘，不让 Agent 手写 YAML
					//    （`aspect: 16:9` 不加引号会被 YAML 解析成整数）。
					return [
						'[手工配图] draft #' + draft.id + '《' + (draft.title || '') + '》',
						'',
						'用户已确认这篇文章定稿，现在要配图。草稿目录：' + dir,
						'',
						'⛔ 不要改正文。配图这一步只处理图。',
						'',
						'## 第一步：让脚本切段（不要自己切）',
						'',
						'跑 `python dsh-workbench/tools/article-images.py plan ' + dir + '`。',
						'它按图位把正文切成段，每段约 400 字，**段落整段取、不切半句、不跨图位**。',
						'返回的 items 里，每个正文图位带 `segment`（该图对应的正文）和 `form`（内容形态）。',
						'如果 `ok=false`，先按 `error` 改 draft.md 的图位前缀，再重跑。',
						'',
						'## 第二步：定画风（你来判断，不是查表）',
						'',
						'先跑 `python dsh-workbench/tools/article-images.py style-log --recent 3`。',
						'`avoid` 里的风格最近三篇用过两次以上，换一个。',
						'',
						'然后读全文，自己判断这篇该用什么画风：',
						'- 风格由**内容**定，不由赛道定。同一个赛道写民生素材和写科技评论，画风不该一样。',
						'- 读 `dsh-workbench/配图路线.md` 第一节的「核心对象→视觉风格」对照，但**那只是参考**。',
						'- 375 个风格分 10 组（FA 国际社论幽默 / FB 经典绘本 / FC 现代平面 / FD 日本当代插画 / FE 新国风 / FF 3D黏土 / FG 动漫赛璐璐 / FH 先锋实验 / FI 写实摄影 / CS 自建）。',
						'- 用 `python dsh-workbench/tools/image-gen.py catalog` 查可用 ID，选定一个。',
						'- **整篇正文图共用同一个风格**（同一篇里风格跳来跳去会散），封面也用这个风格。',
						'',
						'## 第三步：逐个图位提炼画面描述',
						'',
						'对每个正文图位：读它的 `segment` 和 `desc`（原图位描述），提炼成一句**画面描述**。',
						'',
						'写画面描述的硬要求：',
						'- 20–60 字，写**看得见的东西**：在哪、有什么、光从哪来、人在做什么。',
						'  少于 20 字 `article-images.py check` 会判「内容太短」，等于白写，别偷懒。',
						'- 必须是**只有这篇文章会有的细节**。「一个人在思考」是废的，「手指停在付款按钮上没按下去」才有用。',
						'- 不要写「体现」「传达」「象征」这类不可画的话，也不要写 emoji。',
						'- 信息位（图表/清单/对比）的内容必须逐字来自 `segment`，不许自己编数字。',
						'- 图中若有文字，用中文直写要显示的那几个字。',
						'',
						'`form` 决定形态，别搞混：',
						'· 场景还原 → 一个具体时刻 · 对比两栏 → A/B 并置 · 数据图表 → 数字来自正文',
						'· 概念隐喻 → 绑定文章的核心张力 · 流程步骤 → 先后顺序 · 清单要点 → 条目化 · 结构分层 → 层级分明',
						'',
						'## 第四步：封面单独做（要看全文，不是某一段）',
						'',
						'封面跟正文图不是一回事：正文图对应某一段，**封面对应整篇**。',
						'读完整篇之后，提炼一个 15–30 字的画面描述，只画一个核心意象。',
						'封面规范（`配图路线.md` 第四节）：',
						'- **整幅铺满，不允许纯色留白区**；主体占画面高度一半以上；元素不超过 3 个。',
						'- 画幅 2.35:1，微信里只展示 345×147px，**缩略图里认不出就等于白做**。',
						'- **封面一律不写字。** 只画画面。要压标题字走别的功能，不在生图这一步做。',
						'  所以 prompt 里不要出现「写着 / 文字 / 粗体 / 标题字」这类词——',
						'  一旦出现，模型就会自己往画面上编字，实测编出过英文（Keep Going）和俄文。',
						'',
						'## 第五步：落盘 prompt（用脚本写，不要手写）',
						'',
						'把提炼结果写成 JSON，然后交给脚本：',
						'```',
						'{"cover": {"prompt": "封面画面描述"},',
						' "items": [{"index": 1, "prompt": "第1张的画面描述"}, {"index": 2, "prompt": "…"}]}',
						'```',
						'存成 `' + dir + '/spec.json`，跑：',
						'`python dsh-workbench/tools/article-images.py write ' + dir + ' --spec ' + dir + '/spec.json`',
						'它会写出 `imgs/prompts/img-01.md` … 和 `imgs/prompts/cover.md`（frontmatter 由脚本生成）。',
						'',
						'## 第六步：生成图片（**一条命令，并发跑完**）',
						'',
						'把画风 ID 和草稿 id 传给脚本，它会一次建好整组任务并**并发出图**：',
						'```',
						'python dsh-workbench/tools/article-images.py generate ' + dir + ' --style <画风ID> --draft-id ' + draft.id,
						'```',
						'',
						'**必须用这一条命令，不要自己拼 image-gen.py 的单张命令。**',
						'理由：实测过，逐张 `image-gen.py run` 会让 4 张图串行排队，',
						'每张 40 秒以上，整组要等两三分钟。`generate` 内部建 series 后调',
						'`run_series`（线程池，默认 3 路并发），墙钟时间大幅下降。',
						'',
						'返回里 `count` 是总张数、`run.workers` 是实际并发路数。',
						'若 `ok=false`，先看 `error` 和 `run.failed`，多半是某张图生成了但违规/超时，',
						'改那张的画面描述后重跑同一条命令即可（已完成的不重做）。',
						'',
						'## 第七步：看图 + 校验',
						'',
						'- 逐张打开看。封面必看五条：主体够大、345px 认得出、没有纯色块、跟文章相关、',
						'  **画面里一个字都不该有**（模型有时会自己添字，出现了就删掉 prompt 里的写字词重生成）。',
						'- 正文图对照 `segment` 看：画的是不是这段在说的事？不对就改画面描述重生成，不要将就。',
						'- 跑 `python dsh-workbench/tools/article-images.py check ' + dir + '` 确认 prompt 齐全。',
						'- 跑 `check-cover.py` 和 `check-image-log.py`。',
						'',
						'## 第八步：收尾',
						'',
						'- 图放进 `imgs/`（cover.png + img-01.png…）。',
						'- 记风格流水：`article-images.py style-log --append ' + (dir.split(/[\\/]/).pop() || '') + ' <风格ID> <媒介>`',
						'- 回写 cover / imagesCount。',
						'- **不带 --allow-placeholder 重跑 finalize.py**，把真图插进 article.html。',
						'- 跑 `check-all.py ' + dir + ' --stage=layout` 确认，回写 status=illustrated。'
					].join('\n')
				}

				const composeImages = async (draft) => {
					setPending((p) => Object.assign({}, p, { advance: true, advanceId: draft.id }))
					try {
						await triggerAgent(ctx.remote, null, composeImagesPrompt(draft))
						flash('已投递给 Agent 配图：' + (draft.title || '').slice(0, 16))
					} catch (err) {
						const msg = String((err && err.message) || err)
						flash(msg.startsWith('COOLDOWN')
							? ('会话正在跑，' + (msg.split(':')[1] || '稍') + ' 秒后再点')
							: '投递失败：' + msg)
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
						flash(msg.startsWith('COOLDOWN')
							? ('会话正在跑，' + (msg.split(':')[1] || '稍') + ' 秒后再试')
							: '触发失败：' + msg)
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
						'注意：**不要自动写进选题库或我的创作**，等用户看完你的判断再决定。'
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
						// 只有「队列里已排着同一条」才不投递——那种情况 Agent 那轮会一起处理。
						// 重跑（rerunOf）**必须投递**：它是新的一条 pending，
						// 不投递就永远挂在那儿没人管。2026-11-15 踩过这个坑。
						if (res.updated) {
							flash('已在队列里，预设已更新')
						} else if (res.duplicate) {
							// 正常不会走到这里（后端已允许重跑），留作兜底
							flash('这条已经分析过了（' + (res.status || '—') + '），不再重复入队')
						} else if (busy) {
							flash('已入队：分析进行中，这批会一起处理')
						} else {
							try {
								// 带上 focus：让 Agent 优先处理用户刚点的这条，而不是 FIFO 最旧的
								await triggerAgent(ctx.remote, null, analysisPrompt({
									id: res.id, title: row.title,
									// preset 一起带过去，指令里要用
									preset: preset || null
								}))
								flash(res.rerunOf
									? '重新生成中：之前 ' + ((preset && preset.count) || 2) + ' 个选题保留，这次新增同样数量'
									: '已入队并触发分析：' + row.title.slice(0, 14))
							} catch (terr) {
								const msg = String((terr && terr.message) || terr)
								flash(msg.startsWith('COOLDOWN')
									? '已入队：会话正在跑，这批会一起处理'
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

				// 素材行的状态：入队了还是已生成选题
				const rowState = {}
				jobs.forEach((j) => { if (j.source_key) rowState[j.source_key] = (j.status === 'done' ? 'analyzed' : 'queued') })
				topics.forEach((t) => { if (t.source_key) rowState[t.source_key] = 'analyzed' })

				let view
				// 「设置」已提到外层 AppShell，这里不再有设置模块。
				if (mod === '技能包') view = h(SkillPack, { pack: app.pack })
				else if (mod === '每日热榜') view = h(HotRankLibrary, {
					rowState, pending, onPick: (row) => setDialogRow(row), error: dbError,
					onInbox: submitInbox, onOpenInbox: () => setInboxOpen(true),
					// targetSession/onPickSession 已移除：HotRankLibrary 从来没读过这两个 prop，
					// 而对应的 localStorage 手选路径也一并删了。留着只会让人以为这里能选会话。
				})
				else if (mod === '爆文库') view = h(ViralLibrary, {
					rowState, pending, onPick: (row) => setDialogRow(row), error: dbError
				})
				else if (mod === '创作台') view = h(ComposeStudio, {
					preset: composePreset || {},
					// 创作台点【新建创作】时清掉外层缓存的选题，
					// 否则切走再切回会被旧选题覆盖。
					onResetPreset: () => setComposePreset(null),
					onStart: async (cfg) => {
						const r = await startDraft(cfg)
						// 草稿已建，外层缓存的选题可以放掉了，
						// 不然下次切回创作台会又回到「填表」状态。
						if (r && r.id) setComposePreset(null)
						return r
					},
					// 阶段推进与配图：直接复用创作库那两个函数，行为完全一致
					onAdvance: advanceDraft,
					onComposeImages: composeImages,
					onToast: flash,
					onOpenDraft: (id) => { setMod('我的创作'); setSelDraft((drafts || []).find((x) => x.id === id) || null) }
				})
				else if (mod === '选题库') view = h(TopicLibrary, {
					topics, jobs, drafts, loading, error: dbError, sel: selPlan, busy: !!pending.draft,
					onOpen: setSelPlan, onStatus: topicStatus, onRemove: removeTopic,
					onCreateDraft: openConfig,
					onGenerateDaily: generateDailyTopics
				})
				else if (mod === '风格库') view = h(StyleLibrary, { onToast: flash })
				else if (mod === '我的创作') view = h(DraftLibrary, {
					drafts, loading, error: dbError, sel: selDraft, busy: !!pending.advance || !!pending.draft,
					runningId: pending.advanceId || pending.draftId || null,
					onOpen: setSelDraft, onAdvance: advanceDraft, onRemove: removeDraft,
					onPreview: openPreview,
					onZoomCover: (src, title, sub) => setCoverBox({ src, title, sub }),
					onEdit: (draft) => {
						let cfg = {}
						try { cfg = JSON.parse(draft.config_json || '{}') } catch (err) { cfg = {} }
						setComposePreset({
							draftId: draft.id,
							topicId: draft.topic_id || null,
							title: draft.title || '',
							theme: draft.theme || draft.title || '',
							materials: draft.materials || '',
							requirement: draft.requirement || draft.viewpoint || '',
							genre: draft.track || '',
							skill: draft.skill || '',
							config: cfg,
							status: draft.status,
							word_count: draft.word_count
						})
						setMod('创作台')
					},
					onNewConfig: newConfig, onReconfig: reconfigDraft,
					onComposeImages: composeImages,
					// 用复核候选替换标题（2026-11-18）。
					// 只在用户点选时执行 —— 复核结果本身不自动改标题。
					onPickTitle: async (draft, cand) => {
						const next = typeof cand === 'string' ? cand : (cand && cand.title)
						if (!draft || !draft.id || !next) return
						try {
							const r = await apiPost('/api/workbench/drafts', {
								op: 'set-draft', id: draft.id, title: next
							})
							if (!r || r.ok === false) {
								throw new Error((r && r.error) || '保存失败')
							}
							flash('标题已替换')
							await reloadDrafts()
						} catch (err) {
							flash('替换失败：' + String((err && err.message) || err))
						}
					},
					// 制作封面：记下意图 → 切到绘图台。
					//
					// 顺序**必须**是先写意图再切面板：切面板是同步生效的，
					// 反过来的话绘图台挂载时读不到意图，就成了「跳过去但没关联」。
					// 切面板复用顶部 Tab 那套 ctx.layout.selectPanel —— 那是宿主唯一
					// 的公开切面板接口（selectPanel 只收 id，没有参数通道，所以才要这个邮箱）。
					onMakeCover: (r) => {
						if (!r || !r.id) { flash('这篇没有 id，没法关联'); return }
						JumpIntent.toCover(r.id)
						const L = ctx && ctx.layout
						if (!L || typeof L.selectPanel !== 'function') {
							// 切不过去就把意图撤掉，否则它会一直挂着，
							// 用户下次自己手动进绘图台会莫名其妙关联到这篇。
							JumpIntent.pending = null
							flash('切不到绘图台：当前 DSH 没有提供 layout 服务')
							return
						}
						try {
							L.selectPanel('image')
						} catch (err) {
							JumpIntent.pending = null
							flash('切换失败：' + String((err && err.message) || err))
						}
					}
				})
				else if (mod === '发布管理') view = h(PublishLibrary, {
					// 查看全文：复用「全文」窗口那套（TextPreview），
					// 传一个只带 id/title 的最小对象就能用。
					onViewArticle: (pub) => {
						if (!pub || !pub.draft_id) { flash('这条记录没有关联草稿'); return }
						const d = (drafts || []).find((x) => x.id === pub.draft_id)
						openPreview(d || { id: pub.draft_id, title: pub.draft_title || ('草稿 #' + pub.draft_id) })
					},
					publishes, loading: false, error: dbError, sel: selPublish,
					onOpen: setSelPublish, onToast: flash
				})
				else view = h('div', { style: S.body },
					h('div', { style: S.head }, h('h1', { style: S.h1 }, app.label + ' · ' + mod),
						h('p', { style: S.sub }, '这个工作台的模块待实现。')),
					h('div', { style: S.placeholder }, '（空视图）'))

				const waiting = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length
				// AppShell 把侧边栏渲染器交回来（见 AppShell 里 children 是函数的分支）：
				// 布局在外壳，模块状态在这里，各管各的。
				return h(AppShell, { currentKey: app.key, ctx: ctx, mod, onMod: setMod },
					({ sidebar }) => [
						// 侧边栏：只有多模块的工作台才需要
						app.modules.length > 1
							? h('div', {
								key: 'nav',
								style: {
									flex: '0 0 176px', minWidth: 0, overflowY: 'auto',
									padding: '14px 10px',
									borderRight: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)'
								}
							}, sidebar(app.modules, mod, setMod))
							: null,
						h('div', {
							key: 'main',
							style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto' }
						},
							h('div', { style: S.page },
							isGzh
								? h('div', {
									style: {
										padding: '9px 22px 0', fontSize: '12px',
										color: 'var(--dsw-alias-label-secondary)'
									}
								}, '选题方案 ' + topics.length + ' 个'
									+ (waiting ? ' · 待分析 ' + waiting + ' 条' : ''))
								: null,
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
							))            // 收 h('div', {style: S.page})
						]                 // 收 render-prop 返回的数组
					)                     // 收 h(AppShell, ...)
			}
		}
		// layout：切换子工作台要用 ctx.layout.selectPanel(id)。
		// 它是 @deepseek-ai/dsh-client-ui-layout 提供的服务，
		// 不写进 inject 就拿不到（插件管理器的 inject 里也有它）。
		const inject = ['slots', 'remote', 'remote.session', 'layout']

		function apply(ctx) {
			// main 槽位：每个子工作台注册自己的面板（切标签时用到）。
			APPS.forEach((app) => {
				ctx.slots.inject('main', () => ctx.slots.register(
					{ name: 'main', key: app.key, label: app.label }, makeApp(app, ctx)))
			})
			// 侧边栏：**只注册一个入口**。
			// DSH 的 sidebar.panellist 是平级列表，没有父子层级字段，
			// 注册三个图标就是三个并列项。要「一个工作台、三个子面板」，
			// 只能在这里收成一个，内部用顶部标签切。
			// id 用 gzh —— 那是默认落地的子应用，点图标先进公众号台。
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
				{ name: 'sidebar.panellist', id: 'gzh', label: APP_GROUP.label, order: 100 },
				Icon(APP_GROUP)))
		}

		return { name: 'dsh-workbench', inject, apply }
	}
})
