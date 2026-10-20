import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { MockWeather } from './step03ReActAgent.js';

/**
 * Step16 · 工作流智能体 —— LangGraph 式的状态机编排。
 *
 * ReAct 是"模型说了算"的自由循环，但很多业务需要"流程说了算"的
 * 确定性编排。把智能体拆成节点（Node）与边（Edge）：
 * 每个节点是一段能力（分类/工具/问答/润色），条件边决定流转，
 * 状态（State）在节点间传递 —— 这就是 LangGraph 的核心思想，
 * 也是生产系统中"可控性"与"灵活性"的平衡点。
 */

export class WorkflowAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step16 · 工作流状态机（LangGraph 思想）';
    }

    async chat(input) {
        this.lastTrace = [];

        // State：在节点之间流转的共享状态
        const state = new Map();
        state.set('input', input);
        state.set('answer', '');
        state.set('observation', '');

        // 固定入口：classify 节点
        await this.runNode('classify', state);

        // 条件边：按分类结果路由
        const next = state.get('next') ?? 'faq';
        this.lastTrace.push({
            type: 'edge',
            label: '条件边',
            detail: 'classify --' + next + '--> ' + (next === 'tool' ? 'tool 节点' : 'faq 节点'),
        });

        await this.runNode(next, state);
        await this.runNode('polish', state);   // 汇合点：统一润色
        this.lastTrace.push({
            type: 'edge',
            label: 'END',
            detail: '执行路径: classify → ' + next + ' → polish → END',
        });

        return String(state.get('answer'));
    }

    /** 节点执行器：每个节点在 State 上读输入、写产出。 */
    async runNode(node, state) {
        const input = String(state.get('input'));
        const nodePrompt = '[节点:' + node + '] ';
        switch (node) {
            case 'classify': {
                // 意图分类节点：模型输出路由决策
                const raw = (await this.model.chat([
                    Message.system(nodePrompt + `你是意图分类器，只输出 JSON：{"next": "faq|tool", "reason": "一句话"}
涉及天气或四则运算 → tool，其他 → faq
`),
                    Message.user(input),
                ])).trim();
                const parsed = tryParse(raw);
                const next = str(parsed, 'next');
                state.set('next', next == null ? 'faq' : next);
                this.lastTrace.push({ type: 'node', label: '🔹 节点 classify', detail: '路由决策 → ' + state.get('next') });
                break;
            }
            case 'tool': {
                const m = input.match(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/);
                let observation;
                if (m) {
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
                    observation = '计算结果 ' + (Number.isNaN(r) ? '失败' : String(r));
                } else {
                    const city = input.includes('上海') ? '上海' : input.includes('杭州') ? '杭州'
                        : input.includes('成都') ? '成都' : '北京';
                    observation = '「' + city + '」' + MockWeather.query(city);
                }
                state.set('observation', observation);
                this.lastTrace.push({ type: 'node', label: '🔹 节点 tool', detail: observation });
                break;
            }
            case 'faq': {
                const answer = await this.model.chat([
                    Message.system(nodePrompt + '你是 FAQ 问答节点，直接简洁回答常见问题。'),
                    Message.user(input),
                ]);
                state.set('answer', answer);
                this.lastTrace.push({ type: 'node', label: '🔹 节点 faq', detail: clip(answer, 40) });
                break;
            }
            case 'polish': {
                // 汇合润色节点：tool 分支的 observation 在这里转为最终回答
                const obs = String(state.get('observation'));
                const base = obs === ''
                    ? String(state.get('answer'))
                    : '根据查询结果：' + obs;
                const answer = await this.model.chat([
                    Message.system(nodePrompt + `你是润色节点。基于前序节点产出整理最终回答，保持事实不变、表达自然、50 字以内。
前序产出: ${base}
`),
                    Message.user(input),
                ]);
                state.set('answer', answer);
                this.lastTrace.push({ type: 'node', label: '🔹 节点 polish', detail: '最终回答已生成' });
                break;
            }
            default:
                this.lastTrace.push({ type: 'warn', label: '⚠️ 未知节点', detail: node });
        }
    }

    trace() {
        return [...this.lastTrace];
    }
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

function clip(s, n) {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n) + '…' : one;
}
