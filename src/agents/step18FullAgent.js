import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { MockWeather, jdouble } from './step03ReActAgent.js';
import { formatTime } from './step03ReActAgent.js';

/**
 * Step18 · 全流程智能体 —— 把前 17 个场景的能力串成一条完整链路。
 *
 * 前面的场景每次只演示一种能力，这一个类把它们全部组装到一起，
 * 一次 chat() 完整走完生产级智能体的标准生命周期：
 *
 *   输入守卫 → 读取记忆(画像+历史) → 组装上下文 → ReAct 循环(思考→工具→观察)
 *          → 保险丝 → 输出校验 → 回写记忆
 *
 * 注意：它依然只是一个类 + 一个 chat(input) 方法 ——
 * 智能体再复杂，骨架不变；变厚的只是「策略层」。
 * 这也是理解生产框架（LangGraph / Dify / 工业级 Harness）的钥匙：
 * 框架只是把这些环节做成了可配置、可观测、可容错的工程件。
 */

/** 循环保险丝：最多工具轮数（Budget Guard 的一种）。 */
export const MAX_STEPS = 5;

/** 输入长度守卫阈值。 */
export const MAX_INPUT_LEN = 300;

/** 记忆窗口压缩阈值：历史超过该条数时触发压缩。 */
export const COMPRESS_THRESHOLD = 10;

/** 系统提示词：角色 + 能力清单 + 输出协议（Step02 的三层结构）。 */
const SYSTEM_PROMPT = `你是 ToyAgent 综合智能体，具备记忆与工具使用能力。
每一轮只输出一个 JSON 对象，格式二选一：
1. 继续行动：{"thought": "你的思考", "action": "工具名", "action_input": "参数"}
2. 给出答案：{"thought": "你的思考", "final": "最终答案"}
可用工具：
- get_weather(city): 查询城市天气
- calculator(expression): 计算四则运算，如 12*8
- get_time(): 获取当前时间
回答时自然融入用户画像与历史信息；不要输出 JSON 以外的内容。
`;

/** 敏感意图黑名单（教学演示，生产环境用内容安全服务）。 */
const SENSITIVE = /hack|攻击|爆破|破解|密码/i;

/** 画像提取：记住「我叫 XX / 我喜欢 XX」（排除「我叫什么」这类疑问句）。 */
const NAME_PTN = /我(?:叫|的名字(?:是|叫)?)\s*(?!(?:什么|啥|谁))([\u4e00-\u9fa5A-Za-z0-9]{1,12})/;
const LIKE_PTN = /我(?:喜欢|爱)\s*([\u4e00-\u9fa5A-Za-z0-9·\s]{1,12})/;

export class FullAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
        /** 跨轮记忆：历史消息与用户画像（真实项目里这两样在记忆组件中）。 */
        this.history = [];
        this.profile = new Map();
    }

    name() {
        return 'Step18 · 全流程智能体（守卫+记忆+ReAct+工具+保险丝）';
    }

    async chat(input) {
        this.lastTrace = [];

        // ---------- 1. 输入守卫（Step15 的 Guard） ----------
        if (input.length > MAX_INPUT_LEN) {
            this.lastTrace.push({
                type: 'guard', label: '输入守卫',
                detail: '输入长度 ' + input.length + ' 超过上限 ' + MAX_INPUT_LEN + '，直接拒绝，不进模型。',
            });
            return '输入过长，请精简后重试（守卫规则：长度 ≤ ' + MAX_INPUT_LEN + ' 字符）。';
        }
        const sm = input.match(SENSITIVE);
        if (sm) {
            this.lastTrace.push({
                type: 'guard', label: '输入守卫',
                detail: '命中敏感意图黑名单「' + sm[0] + '」，拦截且不消耗模型预算。',
            });
            return '该请求涉及不安全操作，已被输入守卫拦截。智能体的第一道防线在模型之前。';
        }
        this.lastTrace.push({
            type: 'guard', label: '输入守卫',
            detail: '长度与安全检查通过，放行进入后续流程。',
        });

        // ---------- 2. 记忆读取 + 画像提取（Step05 的 Memory） ----------
        this.extractProfile(input);
        this.lastTrace.push({
            type: 'memory', label: '读取记忆',
            detail: '历史 ' + this.history.length + ' 条；画像：'
                + (this.profile.size === 0 ? '暂无' : mapToString(this.profile))
                + '（随请求一起组装进上下文）。',
        });

        // ---------- 3. 组装上下文（system + 历史 + 本轮输入） ----------
        const messages = [];
        messages.push(Message.system(SYSTEM_PROMPT + this.userPortrait()));
        messages.push(...this.history);
        messages.push(Message.user(input));

        // ---------- 4. ReAct 循环（Step03/04 的 Thought→Action→Observation） ----------
        let answer = await this.runReAct(messages);

        // ---------- 5. 输出校验（守卫不只管输入） ----------
        answer = this.outputGuard(answer, input);

        // ---------- 6. 记忆回写 ----------
        this.history.push(Message.user(input));
        this.history.push(Message.assistant(answer));
        let memo = '本轮对话已写入记忆（现共 ' + this.history.length + ' 条）。';
        if (this.history.length > COMPRESS_THRESHOLD) {
            this.compressHistory();
            memo += ' 超过阈值 ' + COMPRESS_THRESHOLD + ' 条 → 上下文压缩已执行（保留系统提示词与最近消息）。';
        }
        this.lastTrace.push({ type: 'memory', label: '回写记忆', detail: memo });
        return answer;
    }

    /** ReAct 主体：与 Step03 相同的循环骨架，外层多了守卫与记忆。 */
    async runReAct(messages) {
        for (let step = 1; step <= MAX_STEPS; step++) {
            let raw = (await this.model.chat(messages)).trim();
            raw = stripCodeFence(raw);
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                // 模型没按协议输出 → 当作最终答案兜底返回
                this.lastTrace.push({ type: 'final', label: 'Final Answer', detail: raw });
                return raw;
            }

            const thought = str(parsed, 'thought');
            this.lastTrace.push({ type: 'thought', label: 'Thought ' + step, detail: thought ?? '' });

            const fin = str(parsed, 'final');
            if (fin != null) {
                this.lastTrace.push({ type: 'final', label: 'Final Answer', detail: fin });
                return fin;
            }

            const action = str(parsed, 'action');
            const actionInput = str(parsed, 'action_input');
            this.lastTrace.push({ type: 'action', label: 'Action ' + step, detail: action + '(' + actionInput + ')' });

            const observation = this.executeTool(action, actionInput);
            this.lastTrace.push({ type: 'tool', label: 'Tool · ' + action, detail: '工具执行完成，产出观察结果。' });
            this.lastTrace.push({ type: 'observation', label: 'Observation ' + step, detail: observation });

            messages.push(Message.assistant(raw));
            messages.push(Message.user('Observation: ' + observation));
        }
        const msg = '已达最大步数 ' + MAX_STEPS + '，保险丝熔断，循环终止（Budget Guard）。';
        this.lastTrace.push({ type: 'guard', label: '保险丝', detail: msg });
        return msg;
    }

    /** 工具注册表：本地 switch 执行器（真实项目里是 MCP/插件网关）。 */
    executeTool(action, input) {
        try {
            switch (action ?? '') {
                case 'get_weather': return MockWeather.query(input);
                case 'calculator': return jdouble(this.calc(input));
                case 'get_time': return formatTime();
                default: return '未知工具: ' + action;
            }
        } catch (e) {
            return '工具执行失败: ' + e.message;
        }
    }

    /** 输出守卫：拦截答案中的敏感内容，并在能回答画像问题时兜底。 */
    outputGuard(answer, input) {
        if (answer != null && SENSITIVE.test(answer)) {
            this.lastTrace.push({
                type: 'guard', label: '输出守卫',
                detail: '答案命中敏感词，替换为安全话术后返回。',
            });
            return '该内容不宜展示，已由输出守卫处理。';
        }
        // 记忆兜底：模型看不到被压缩掉的历史时，画像仍能回答「我叫什么」
        if (input.includes('我叫什么') || input.includes('我是谁')) {
            const name = this.profile.get('名字');
            if (name != null) {
                this.lastTrace.push({
                    type: 'memory', label: '画像兜底',
                    detail: '命中画像「名字=' + name + '」，无需再问模型。',
                });
                return '你叫 ' + name + '（来自画像记忆，不依赖模型）。';
            }
        }
        return answer;
    }

    /** 从输入中提取用户画像（生产环境由记忆组件用模型抽取）。 */
    extractProfile(input) {
        const n = input.match(NAME_PTN);
        if (n) this.profile.set('名字', n[1]);
        const l = input.match(LIKE_PTN);
        if (l) this.profile.set('喜好', l[1].trim());
    }

    /** 画像注入提示词的片段。 */
    userPortrait() {
        if (this.profile.size === 0) return '';
        return '\n已知用户画像：' + mapToString(this.profile) + '（回答时自然使用，不要逐字复述）。';
    }

    /** 上下文压缩：保留系统提示词语义（此实现重建时自动携带）与最近 6 条。 */
    compressHistory() {
        const keep = Math.min(6, this.history.length);
        const kept = this.history.slice(this.history.length - keep);
        this.history = kept;
    }

    /** 教学用四则运算求值（与 Step03 相同）。 */
    calc(expr) {
        const m = expr.match(/^\s*(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)\s*$/);
        if (!m) throw new Error('无法解析表达式: ' + expr);
        const a = parseFloat(m[1]);
        const b = parseFloat(m[3]);
        switch (m[2]) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/':
                if (b === 0) throw new Error('除数不能为 0');
                return a / b;
            default: throw new Error('不支持的运算符 ' + m[2]);
        }
    }

    reset() {
        this.history = [];
        this.profile.clear();
    }

    trace() {
        return [...this.lastTrace];
    }
}

/** 模拟 Java Map.toString()：{名字=小傅} —— 画像字符串与 Java 输出一致（Mock 剧本依赖「名字={」）。 */
function mapToString(map) {
    return '{' + [...map.entries()].map(([k, v]) => k + '=' + v).join(', ') + '}';
}

function str(parsed, key) {
    return parsed != null && typeof parsed === 'object' ? parsed[key] : undefined;
}

function stripCodeFence(s) {
    if (s.startsWith('```')) {
        s = s.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim();
    }
    return s;
}
