import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { MockWeather } from './step03ReActAgent.js';

/**
 * Step04 · 工具调用（Function Calling）—— 给模型装上"手脚"。
 *
 * 与 Step03 手写 ReAct 循环不同，本场景展示标准的工具调用交互：
 * 1. 在提示词中声明工具清单（名称、参数、用途）—— 即最简 Tool Schema；
 * 2. 模型判断需要工具时，返回结构化调用请求 {"tool": "...", "arguments": {...}}；
 * 3. 智能体执行工具，把结果作为新消息回填，再次请求模型生成最终回答。
 *
 * 生产中 OpenAI 的 tools/tool_calls 协议、MCP 协议，本质都是这三步。
 */

const SYSTEM_PROMPT = `你是一个可以调用工具的智能体。可用工具：
- get_weather(city): 查询指定城市的实时天气
- calculator(expression): 计算四则运算，如 12*8

决策规则：
- 需要工具时，只输出 JSON：{"tool": "工具名", "arguments": {"参数名": "值"}}
- 不需要工具时，直接用自然语言回答，不要输出 JSON。
`;

export class ToolCallAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step04 · 工具调用（Function Calling）';
    }

    async chat(input) {
        this.lastTrace = [];
        const messages = [
            Message.system(SYSTEM_PROMPT),
            Message.user(input),
        ];

        // 第一轮：模型决定"要不要用工具"
        const first = (await this.model.chat(messages)).trim();
        const decision = tryParse(first);

        if (decision && typeof decision === 'object' && str(decision, 'tool') != null) {
            const tool = decision.tool;
            const args = JSON.stringify(decision.arguments);
            this.lastTrace.push({ type: 'tool', label: '模型发起工具调用', detail: tool + ' ' + args });

            // 第二步：执行工具
            const result = this.execute(tool, args);
            this.lastTrace.push({ type: 'observation', label: '工具返回结果', detail: result });

            // 第三步：结果回填，让模型基于事实作答
            messages.push(Message.assistant(first));
            messages.push(Message.user('工具 ' + tool + ' 的执行结果: ' + result));
            const answer = await this.model.chat(messages);
            this.lastTrace.push({ type: 'final', label: '基于工具结果生成回答', detail: '模型拿到 Observation 后组织最终回答' });
            return answer;
        }

        // 模型选择不调用工具，直接回答
        this.lastTrace.push({ type: 'final', label: '无需工具，直接回答', detail: '模型判断自身知识足够' });
        return first;
    }

    execute(tool, argsJson) {
        try {
            const args = JSON.parse(argsJson ?? '{}');
            switch (tool) {
                case 'get_weather':
                    return MockWeather.query(str(args, 'city'));
                case 'calculator': {
                    const m = String(str(args, 'expression'))
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
                    return '未知工具: ' + tool;
            }
        } catch (e) {
            return '工具执行失败: ' + e.message;
        }
    }

    trace() {
        return [...this.lastTrace];
    }
}

function str(o, key) {
    return o != null && typeof o === 'object' ? o[key] : undefined;
}

/** Java String.valueOf(double) 风格：整数值输出带 .0（如 "8.0"）。 */
function jnum(n) {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function tryParse(raw) {
    try {
        return JSON.parse(raw.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim());
    } catch {
        return raw;
    }
}
