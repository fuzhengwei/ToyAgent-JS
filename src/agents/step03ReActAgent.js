import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step03 · ReAct 智能体 —— 让模型学会"边想边做"。
 *
 * ReAct = Reasoning + Acting。模型不再一次作答，而是输出结构化的
 * Thought（思考）→ Action（行动）→ 等待 Observation（观察结果），
 * 智能体执行工具后把结果喂回模型，循环直到模型给出 Final Answer。
 * 这是几乎所有智能体框架（LangChain、Agent Loop）的内核。
 */

export const MAX_STEPS = 5;

/** 用系统提示词约定 ReAct 的输出协议（JSON 形式，便于解析）。 */
export const SYSTEM_PROMPT = `你是一个使用 ReAct 模式解决问题的智能体。
每一轮只输出一个 JSON 对象，格式二选一：
1. 继续行动：{"thought": "你的思考", "action": "工具名", "action_input": "参数"}
2. 给出答案：{"thought": "你的思考", "final": "最终答案"}
可用工具：
- get_weather(city): 查询城市天气
- calculator(expression): 计算四则运算，如 12*8
- get_time(): 获取当前时间
不要输出 JSON 以外的内容。
`;

/** Java String.valueOf(double) 风格：整数值输出带 .0（如 "8.0"）。 */
export function jdouble(n) {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

export class ReActAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step03 · ReAct 智能体（思考-行动-观察循环）';
    }

    async chat(input) {
        this.lastTrace = [];
        const messages = [
            Message.system(SYSTEM_PROMPT),
            Message.user(input),
        ];

        for (let step = 1; step <= MAX_STEPS; step++) {
            // 1. 模型思考并决策
            let raw = (await this.model.chat(messages)).trim();
            raw = stripCodeFence(raw);
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                // 模型没按协议输出 → 视为最终答案直接返回
                this.lastTrace.push({ type: 'final', label: 'Final Answer', detail: raw });
                return raw;
            }

            const thought = str(parsed, 'thought');
            this.lastTrace.push({ type: 'thought', label: 'Thought ' + step, detail: thought ?? '' });

            // 2. 有 final → 循环结束
            const fin = str(parsed, 'final');
            if (fin != null) {
                this.lastTrace.push({ type: 'final', label: 'Final Answer', detail: fin });
                return fin;
            }

            // 3. 有 action → 执行工具，把观察结果喂回模型
            const action = str(parsed, 'action');
            const actionInput = str(parsed, 'action_input');
            this.lastTrace.push({ type: 'action', label: 'Action ' + step, detail: action + '(' + actionInput + ')' });

            const observation = this.executeTool(action, actionInput);
            this.lastTrace.push({ type: 'observation', label: 'Observation ' + step, detail: observation });

            messages.push(Message.assistant(raw));
            messages.push(Message.user('Observation: ' + observation));
        }
        const msg = '已达最大步数 ' + MAX_STEPS + '，循环终止（生产系统必须有这个保险丝）。';
        this.lastTrace.push({ type: 'guard', label: '达到最大步数', detail: msg });
        return msg;
    }

    /** 工具注册表：本场景仅 3 个本地工具，执行器就是一个 switch。 */
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

    /** 教学用四则运算求值（仅支持 a op b）。 */
    calc(expr) {
        const m = expr.match(/^\s*(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)\s*$/);
        if (!m) throw new Error('无法解析表达式: ' + expr);
        const a = parseFloat(m[1]);
        const op = m[2];
        const b = parseFloat(m[3]);
        switch (op) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/':
                if (b === 0) throw new Error('除数不能为 0');
                return a / b;
            default: throw new Error('不支持的运算符 ' + op);
        }
    }

    trace() {
        return [...this.lastTrace];
    }
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

export function formatTime() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 本地 Mock 天气数据（step03/04/06/09/10/15/16/18 共用，对应 Java ReActAgent.MockWeather）。 */
export class MockWeather {
    static DATA = {
        '北京': '晴，26℃', '上海': '多云，28℃', '广州': '雷阵雨，31℃',
        '深圳': '阵雨，30℃', '杭州': '晴，27℃', '成都': '阴，22℃',
    };

    static query(city) {
        const key = (city ?? '').trim();
        return this.DATA[key] ?? ('未收录城市 ' + key + ' 的数据');
    }
}
