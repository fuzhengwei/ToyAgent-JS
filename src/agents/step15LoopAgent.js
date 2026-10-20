import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { MockWeather } from './step03ReActAgent.js';

/**
 * Step15 · Loop 运行时智能体 —— 生产级 Agent Loop 的骨架。
 *
 * Step03 的 ReAct 循环是"裸奔"的：没有保险丝、没有安全检查。
 * 真实的智能体运行时（Runtime）在循环外面包了一层工程化外壳：
 * - 输入守卫 —— 拦截敏感/恶意请求（Prompt 注入防护）；
 * - 最大步数 —— 防止模型陷入死循环烧钱；
 * - 输出守卫 —— 对最终回答做合规过滤；
 * - 异常兜底 —— 工具失败不拖垮整个循环。
 *
 * 模型负责聪明，运行时负责可靠。
 */

export const MAX_STEPS = 4;
export const MAX_INPUT_CHARS = 500;

/** 敏感词黑名单（生产中应为规则引擎 + 分类模型）。 */
const BLOCKED = ['密码', '攻击', 'hack', '漏洞', '暴力', '炸药'];

const SYSTEM_PROMPT = `你是运行在受控运行时里的智能体。每轮只输出 JSON：
{"thought": "思考", "action": "get_weather|calculator", "action_input": "参数"}
或 {"thought": "思考", "final": "最终答案"}
可用工具：get_weather(city)、calculator(expression)
`;

export class LoopAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step15 · Agent Loop 运行时（守卫 + 保险丝）';
    }

    async chat(input) {
        this.lastTrace = [];

        // ---------- 输入守卫 ----------
        if (input.length > MAX_INPUT_CHARS) {
            this.lastTrace.push({ type: 'guard', label: '⛔ 输入守卫拦截', detail: '输入超过 ' + MAX_INPUT_CHARS + ' 字符上限' });
            return '输入过长，已拦截（防止上下文爆炸与注入攻击面扩大）。';
        }
        for (const word of BLOCKED) {
            if (input.toLowerCase().includes(word)) {
                this.lastTrace.push({ type: 'guard', label: '⛔ 输入守卫拦截', detail: '命中敏感词: ' + word + '（Prompt 注入/安全防护）' });
                return '该请求涉及受限内容，已被输入守卫拦截。';
            }
        }
        this.lastTrace.push({ type: 'guard', label: '🛡️ 输入守卫通过', detail: '长度 ' + input.length + ' 字符，未命中敏感词' });

        // ---------- Agent Loop ----------
        const messages = [
            Message.system(SYSTEM_PROMPT),
            Message.user(input),
        ];

        for (let step = 1; step <= MAX_STEPS; step++) {
            let raw;
            try {
                raw = (await this.model.chat(messages)).trim();
            } catch (e) {
                this.lastTrace.push({ type: 'warn', label: '⚠️ 异常兜底', detail: '模型调用失败: ' + e.message });
                return '运行时异常已兜底，请稍后重试。';
            }
            const parsed = tryParse(raw);
            const thought = str(parsed, 'thought');
            if (thought != null) {
                this.lastTrace.push({ type: 'thought', label: 'Thought ' + step, detail: thought });
            }

            const fin = str(parsed, 'final');
            if (fin != null) {
                // ---------- 输出守卫 ----------
                for (const word of BLOCKED) {
                    if (fin.toLowerCase().includes(word)) {
                        this.lastTrace.push({ type: 'guard', label: '⛔ 输出守卫拦截', detail: '回答命中敏感词，已替换为安全话术' });
                        return '回答未通过输出合规检查，已按安全策略处理。';
                    }
                }
                this.lastTrace.push({ type: 'final', label: '✅ 输出守卫通过 · Final', detail: '循环共执行 ' + step + ' 步' });
                return fin;
            }

            const action = str(parsed, 'action');
            const actionInput = str(parsed, 'action_input');
            this.lastTrace.push({ type: 'action', label: 'Action ' + step, detail: action + '(' + actionInput + ')' });

            // 工具异常不拖垮循环
            let observation;
            try {
                observation = execute(action, actionInput);
            } catch (e) {
                observation = '工具执行异常: ' + e.message;
                this.lastTrace.push({ type: 'warn', label: '⚠️ 工具异常', detail: observation });
            }
            this.lastTrace.push({ type: 'observation', label: 'Observation ' + step, detail: observation });

            messages.push(Message.assistant(raw));
            messages.push(Message.user('Observation: ' + observation));
        }

        this.lastTrace.push({ type: 'guard', label: '🔥 保险丝熔断', detail: '达到最大步数 ' + MAX_STEPS + '，强制终止循环' });
        return '已达到最大执行步数（' + MAX_STEPS + '），为控制成本与风险强制终止。';
    }

    trace() {
        return [...this.lastTrace];
    }
}

function execute(action, input) {
    switch (action ?? '') {
        case 'get_weather':
            return MockWeather.query(input);
        case 'calculator': {
            const m = (input ?? '')
                .match(/^\s*(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)\s*$/);
            if (!m) return '无法解析表达式';
            const a = parseFloat(m[1]);
            const b = parseFloat(m[3]);
            switch (m[2]) {
                case '+': return jnum(a + b);
                case '-': return jnum(a - b);
                case '*': return jnum(a * b);
                case '/': return b === 0 ? '除数不能为 0' : jnum(a / b);
                default: return '不支持的运算符';
            }
        }
        default:
            return '未知工具: ' + action;
    }
}

/** Java String.valueOf(double) 风格：整数值输出带 .0（如 "8.0"）。 */
function jnum(n) {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function str(o, key) {
    return o != null && typeof o === 'object' ? o[key] : undefined;
}

function tryParse(raw) {
    try {
        return JSON.parse(raw.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim());
    } catch {
        return {};
    }
}
