import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { MockWeather } from './step03ReActAgent.js';

/**
 * Step06 · 意图路由智能体 —— Agent 的大脑：先识别意图，再决策走向。
 *
 * 复杂系统不会把所有问题都丢给一个循环：先让模型做一次"意图识别"
 * （输出 JSON 分类），再由决策中枢把请求路由到不同处理器 ——
 * 天气走工具、算式走计算器、闲聊走对话。这正是 Agent Loop 中
 * Router/Dispatcher 的原型，也是多智能体系统编排的前置能力。
 */

const ROUTER_PROMPT = `你是意图识别路由器。分析用户输入，只输出 JSON：
{"intent": "weather|math|chat", "reason": "一句话理由"}
- weather: 查询天气
- math: 四则运算
- chat: 其他一切对话
`;

export class RouterAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step06 · 意图识别与决策中枢（路由）';
    }

    async chat(input) {
        this.lastTrace = [];

        // 1. 意图识别
        const raw = (await this.model.chat([
            Message.system(ROUTER_PROMPT),
            Message.user(input),
        ])).trim();
        const decision = tryParse(raw);
        let intent = str(decision, 'intent');
        if (intent == null) intent = 'chat';
        this.lastTrace.push({
            type: 'intent',
            label: '意图识别',
            detail: intent + '（' + (str(decision, 'reason') ?? '') + '）',
        });

        // 2. 按意图路由到不同处理器
        switch (intent) {
            case 'weather': {
                const city = extractCity(input);
                this.lastTrace.push({ type: 'action', label: '路由 → 天气工具', detail: 'get_weather(' + city + ')' });
                const result = MockWeather.query(city);
                this.lastTrace.push({ type: 'observation', label: '工具返回', detail: result });
                return '「' + city + '」现在' + result + '。';
            }
            case 'math': {
                this.lastTrace.push({ type: 'action', label: '路由 → 计算器', detail: input });
                return '计算结果：' + this.calc(input) + '。';
            }
            default: {
                this.lastTrace.push({ type: 'action', label: '路由 → 对话模型', detail: '无工具直答' });
                return this.model.chat([
                    Message.system('你是一个友好的中文聊天助手。'),
                    Message.user(input),
                ]);
            }
        }
    }

    calc(expr) {
        const m = expr.match(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/);
        if (!m) return '未识别的算式';
        const a = parseFloat(m[1]);
        const b = parseFloat(m[3]);
        let r;
        switch (m[2]) {
            case '+': r = a + b; break;
            case '-': r = a - b; break;
            case '*': r = a * b; break;
            case '/': r = b === 0 ? NaN : a / b; break;
            default: r = NaN;
        }
        return Number.isNaN(r) ? '无法计算' : String(r);
    }

    trace() {
        return [...this.lastTrace];
    }
}

function extractCity(text) {
    for (const city of ['北京', '上海', '广州', '深圳', '杭州', '成都']) {
        if (text.includes(city)) return city;
    }
    return '北京';
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
