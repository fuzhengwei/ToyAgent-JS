import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { ToolRegistry } from './step11RegistryAgent.js';
import { MockWeather } from './step03ReActAgent.js';

/**
 * Step17 · ReAct 运行时 —— turn/step 两级循环 + 上下文裁剪 + TurnEndReason。
 *
 * 参考 deepseek-harness-java 的 ReactLoopAgent（994 行）拆出的教学骨架，三个核心机制：
 * 1. turn/step 两级循环：一次 chat() = 一个 turn；turn 内的 while 是 step 循环。
 *    与 Step03 的区别：工具执行完不结束回合，而是续步（mid-turn continuation）——
 *    循环只能以 TurnEndReason 收场；
 * 2. 上下文裁剪 truncateToBudget：每次调模型前估算 token（≈字符数/4），
 *    超预算就从最老的非系统消息开始丢弃（保底留最近 4 条）。多轮对话后
 *    在轨迹里能亲眼看到「上下文裁剪」事件；
 * 3. 步数保险丝：单回合最多 MAX_STEPS_PER_TURN 步，超限以
 *    TurnEndReason.MaxSteps 收场（发「死循环测试」可亲眼看到保险丝起跳）。
 *
 * 工具直接复用 Step11 的 ToolRegistry —— 运行时与工具协议天然解耦。
 */

/** 单回合步数保险丝（dsh-java 同款思想，生产值通常为 50）。 */
export const MAX_STEPS_PER_TURN = 6;
/** 上下文 token 预算（教学值调小以便演示，约 4 轮触发；估算规则：token ≈ 字符数 / 4）。 */
export const BUDGET_TOKENS = 100;
/** 裁剪时保底保留的最近消息条数。 */
export const KEEP_MIN = 4;

/**
 * 回合结束原因（TurnEndReason）—— 用封闭类型统一表达"循环为什么停"。
 * Java 用 sealed interface + record 做穷尽检查；JS 没有 sealed 类型，
 * 用 type 字段的判别联合对象表达同样的三种结局：
 * - { kind: 'Completed', summary } —— 正常完成（模型给出最终答案）；
 * - { kind: 'MaxSteps', steps }    —— 触达单回合步数保险丝，强制终止；
 * - { kind: 'Error', message }     —— 异常终止（模型失约、工具崩溃等）。
 */
export const TurnEndReason = {
    completed: summary => ({ kind: 'Completed', summary }),
    maxSteps: steps => ({ kind: 'MaxSteps', steps }),
    error: message => ({ kind: 'Error', message }),
};

const SYSTEM_PROMPT = `你是一个使用 ReAct 模式的智能体，运行在 turn/step 两级循环之上。
可用工具（由注册表生成）：
`;

// ------------------------------------------------------------------ 工具

const WEATHER_DATA = {
    '北京': '晴，26℃', '上海': '多云，28℃', '广州': '雷阵雨，31℃',
    '深圳': '阵雨，30℃', '杭州': '晴，27℃', '成都': '阴，22℃',
};

class WeatherTool {
    name() { return 'get_weather'; }
    description() { return '查询指定城市的实时天气'; }
    parameters() { return { 'city': 'string，城市名' }; }
    execute(args) {
        const city = String(args.city ?? '').trim();
        return WEATHER_DATA[city] ?? ('未收录城市 ' + city + ' 的数据');
    }
}

class CalculatorTool {
    name() { return 'calculator'; }
    description() { return '计算四则运算，如 12*8'; }
    parameters() { return { 'expression': 'string，算式' }; }
    execute(args) {
        const m = String(args.expression ?? '')
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
}

/** 永远回显的工具：专供「死循环测试」演示保险丝。 */
class EchoTool {
    name() { return 'echo'; }
    description() { return '回显输入文本（演示用）'; }
    parameters() { return { 'text': 'string，要回显的内容' }; }
    execute(args) {
        return 'echo: ' + (args.text ?? '');
    }
}

/** Java String.valueOf(double) 风格：整数值输出带 .0（如 "8.0"）。 */
function jnum(n) {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

// ------------------------------------------------------------------ 场景主体

export class RuntimeAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.registry = new ToolRegistry();
        /** 跨对话的会话历史：运行时的上下文管理正是作用在它上面。 */
        this.history = [];
        this.lastTrace = [];
        this.lastAnswer = '';
        this.registry.register(new WeatherTool());
        this.registry.register(new CalculatorTool());
        this.registry.register(new EchoTool());
    }

    name() {
        return 'Step17 · ReAct 运行时（turn/step + 上下文裁剪 + TurnEndReason）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.history.push(Message.user(input));

        // ===== 机制 2：调模型前先做上下文预算裁剪 =====
        this.trimToBudget();

        // ===== 机制 1：turn 内的 step 循环，只能以 TurnEndReason 收场 =====
        const reason = await this.runTurn(input);

        // 回合结束原因入轨迹，并作为 user 消息回写历史（下一轮模型可见）
        let label;
        const fused = reason.kind === 'MaxSteps';
        if (reason.kind === 'Completed') {
            label = 'Turn 结束 · COMPLETED —— ' + reason.summary;
        } else if (reason.kind === 'MaxSteps') {
            label = 'Turn 结束 · MAX_STEPS —— 达到保险丝 ' + reason.steps + ' 步，强制收敛';
        } else {
            label = 'Turn 结束 · ERROR —— ' + reason.message;
        }
        this.lastTrace.push({
            type: fused ? 'guard' : 'final',
            label, detail: '结束原因以封闭类型 TurnEndReason 统一表达，逐一分支处理',
        });
        return this.lastAnswer;
    }

    /** 一个 turn：循环执行 step，直到出现结束原因。 */
    async runTurn(input) {
        for (let step = 1; step <= MAX_STEPS_PER_TURN; step++) {
            // ---- 组装请求：系统提示词 + 会话历史（裁剪后） ----
            const req = [];
            req.push(Message.system(SYSTEM_PROMPT + this.registry.promptCatalog()
                + '\n决策规则：\n- 需要工具时，只输出 JSON：'
                + '{"thought": "思考", "action": "工具名", "action_input": "参数"}\n'
                + '- 信息足够时，只输出 JSON：{"thought": "思考", "final": "最终答案"}\n'
                + '不要输出 JSON 以外的内容。'));
            req.push(...this.history);

            let raw;
            try {
                raw = (await this.model.chat(req)).trim();
            } catch (e) {
                return TurnEndReason.error('模型调用失败: ' + e.message);
            }
            const parsed = tryParse(raw);
            this.lastTrace.push({
                type: 'thought', label: 'Step ' + step + ' · 思考',
                detail: firstLine(str(parsed, 'thought'), raw),
            });

            if (parsed == null || typeof parsed !== 'object') {
                // 模型失约：按协议约定视为最终答案
                this.lastAnswer = raw;
                this.history.push(Message.assistant(raw));
                return TurnEndReason.completed('模型直接给出答案');
            }

            const fin = str(parsed, 'final');
            if (fin != null) {
                this.lastAnswer = fin;
                this.history.push(Message.assistant(raw));
                return TurnEndReason.completed('模型给出最终答案');
            }

            // ---- 工具调用：执行后续步（不结束回合，这就是"续步"） ----
            const action = str(parsed, 'action');
            const actionInput = str(parsed, 'action_input');
            this.lastTrace.push({
                type: 'action', label: 'Step ' + step + ' · 行动',
                detail: action + '(' + actionInput + ')',
            });

            const tool = this.registry.lookup(action);
            let observation;
            if (tool == null) {
                observation = '未知工具: ' + action + '。可用清单：\n' + this.registry.promptCatalog();
            } else {
                try {
                    observation = await tool.execute({ city: nz(actionInput), expression: nz(actionInput), text: nz(actionInput) });
                } catch (e) {
                    observation = '工具执行失败: ' + e.message;
                }
            }
            this.lastTrace.push({ type: 'observation', label: 'Step ' + step + ' · 观察', detail: observation });

            // 观察结果进历史 —— 下一 step 模型自然"看见"，循环继续
            this.history.push(Message.assistant(raw));
            this.history.push(Message.user('Observation: ' + observation));
            this.trimToBudget();
        }
        this.lastAnswer = '已达最大步数 ' + MAX_STEPS_PER_TURN + '，本回合被保险丝强制终止。'
            + '生产系统的 ReAct 循环必须有这层兜底（dsh-java 默认 50 步）。';
        return TurnEndReason.maxSteps(MAX_STEPS_PER_TURN);
    }

    // ===== 机制 2：上下文预算裁剪（truncateToBudget，~15 行核心逻辑） =====

    trimToBudget() {
        if (estimateTokens(this.history) <= BUDGET_TOKENS || this.history.length <= KEEP_MIN) return;
        // 从最老的消息开始丢（历史里没有系统消息，系统提示词在请求时单独加）
        let drop = 0;
        while (estimateTokens(this.history) > BUDGET_TOKENS && this.history.length > KEEP_MIN) {
            this.history.shift();
            drop++;
        }
        this.lastTrace.push({
            type: 'compress', label: '上下文裁剪 truncateToBudget',
            detail: '预估 token 超过预算 ' + BUDGET_TOKENS + '，丢弃最早 ' + drop
                + ' 条消息，保留最近 ' + this.history.length + ' 条，现估 '
                + estimateTokens(this.history) + ' tokens',
        });
    }

    reset() {
        this.history = [];
        this.registry.clear();
        this.registry.register(new WeatherTool());
        this.registry.register(new CalculatorTool());
        this.registry.register(new EchoTool());
    }

    trace() {
        return [...this.lastTrace];
    }
}

/** 估算 token：教学化近似 —— token ≈ 字符数 / 4（dsh-java 同款估算）。 */
function estimateTokens(msgs) {
    return msgs.reduce((sum, m) => sum + Math.floor(m.content.length / 4), 0);
}

// ------------------------------------------------------------------ 工具方法

function str(parsed, key) {
    return parsed != null && typeof parsed === 'object' ? parsed[key] : undefined;
}

function nz(s) {
    return s == null ? '' : s;
}

function firstLine(a, b) {
    const s = (a == null || a.trim() === '') ? b : a;
    const i = s.indexOf('\n');
    return i > 0 ? s.slice(0, i) : s;
}

function tryParse(raw) {
    try {
        return JSON.parse(raw.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim());
    } catch {
        return raw;
    }
}
