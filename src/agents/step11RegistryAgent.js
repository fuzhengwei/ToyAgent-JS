import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { formatTime } from './step03ReActAgent.js';

/**
 * Step11 · 工具注册表 —— 用「协议 + 注册表」取代写死的 switch。
 *
 * 与 Step04 的三点不同：
 * 1. 工具实现 ToolDefinition 协议，注册进 ToolRegistry；
 * 2. 系统提示词里的工具清单由注册表自动生成 —— 注册即生效、注销即消失；
 * 3. 执行器只做 lookup + execute，不再认识任何具体工具。
 *
 * 试试本场景的本地指令：
 *   查看工具清单          —— 看注册表当前内容（也是模型每次看到的清单）
 *   卸载：get_time        —— 用注销器摘除工具，再问时间模型就说"没有该工具了"
 */

/**
 * Step11 · 工具定义协议 —— 一个接口 = 一个工具。
 *
 * Step03/04 里工具是写死在 switch 分支里的：加一个工具要改执行器代码。
 * 本场景把"工具"抽象成统一协议（参考 deepseek-harness-java 的 ToolDefinition）：
 * - name() 工具名 —— 模型调用时使用的标识；
 * - description() 用途描述 —— 模型据此判断"该不该用这个工具"；
 * - parameters() 参数说明 —— 生产中是 JSON Schema，教学化简为「参数名 → 类型说明」；
 * - execute(args) 执行逻辑 —— 工具的真正手脚。
 * 实现这个协议 + 注册进注册表 = 一个模型可见、可调用的工具。
 */
export class ToolDefinition {
    name() { throw new Error('ToolDefinition 子类必须实现 name()'); }
    description() { throw new Error('ToolDefinition 子类必须实现 description()'); }
    parameters() { throw new Error('ToolDefinition 子类必须实现 parameters()'); }
    async execute(args) { throw new Error('ToolDefinition 子类必须实现 execute(args)'); }
    /** 是否可并行执行（fs 读类 true，shell 写类 false）—— 预留并行调度语义。 */
    concurrencySafe() { return false; }
}

/**
 * Step11 · 工具注册表 —— 模型"看得见"的工具目录。
 *
 * 三个职责（与 deepseek-harness-java 的 ToolRegistry/AgentToolCatalog 同构）：
 * 1. 注册：register() 把工具放进目录，并返回一个「注销器函数」——
 *    持有它就能把工具从目录摘除。插件停止/卸载时，宿主靠这个句柄回收注册项，
 *    这就是「注册-回收对称性」；
 * 2. 发现：lookup() 按名字取工具，执行器只认注册表、不认具体工具；
 * 3. 清单生成：promptCatalog() 把目录渲染成系统提示词里的工具清单 ——
 *    模型能看见哪些工具，完全由注册表当前内容决定。注册即生效，注销即消失。
 */
export class ToolRegistry {
    constructor() {
        this.tools = new Map();
    }

    /** 注册工具，返回注销器（disposer）：调用它即把该工具从目录摘除。 */
    register(tool) {
        this.tools.set(tool.name(), tool);
        return () => {
            this.tools.delete(tool.name());
        };
    }

    /** 按名字查找工具。 */
    lookup(name) {
        return name == null ? undefined : this.tools.get(name);
    }

    size() {
        return this.tools.size;
    }

    isEmpty() {
        return this.tools.size === 0;
    }

    /** 清空注册表（重置场景时使用）。 */
    clear() {
        this.tools.clear();
    }

    /**
     * 把当前目录渲染成系统提示词中的工具清单 ——
     * 工具增删后无需改任何提示词代码，下一次对话模型自动"看见"变化。
     */
    promptCatalog() {
        let sb = '';
        for (const t of this.tools.values()) {
            sb += '- ' + t.name() + '(';
            let i = 0;
            for (const [k, v] of Object.entries(t.parameters())) {
                if (i++ > 0) sb += ', ';
                sb += k + ': ' + v;
            }
            sb += ') — ' + t.description() + '\n';
        }
        return sb;
    }
}

// ------------------------------------------------------------------ 内置工具：三个 ToolDefinition 实现

const WEATHER_DATA = {
    '北京': '晴，26℃', '上海': '多云，28℃', '广州': '雷阵雨，31℃',
    '深圳': '阵雨，30℃', '杭州': '晴，27℃', '成都': '阴，22℃',
};

/** 天气查询工具：实现协议四件套，即插即用。 */
class WeatherTool extends ToolDefinition {
    name() { return 'get_weather'; }
    description() { return '查询指定城市的实时天气'; }
    parameters() { return { 'city': 'string，城市名，如 北京' }; }
    execute(args) {
        const city = String(args.city ?? '').trim();
        return WEATHER_DATA[city] ?? ('未收录城市 ' + city + ' 的数据');
    }
}

/** 四则运算工具。 */
class CalculatorTool extends ToolDefinition {
    name() { return 'calculator'; }
    description() { return '计算四则运算，如 12*8'; }
    parameters() { return { 'expression': 'string，算式，如 12*8' }; }
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

/** 时间工具。 */
class TimeTool extends ToolDefinition {
    name() { return 'get_time'; }
    description() { return '获取当前时间'; }
    parameters() { return {}; }
    execute(args) {
        return formatTime();
    }
}

/** Java String.valueOf(double) 风格：整数值输出带 .0（如 "8.0"）。 */
function jnum(n) {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

// ------------------------------------------------------------------ 场景主体

const SYSTEM_PROMPT_PREFIX = `你是一个可以调用工具的智能体。可用工具清单（由注册表自动生成）：
`;

export class RegistryAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.registry = new ToolRegistry();
        /** 每个工具的注销器：插件热卸载时宿主靠它回收注册项。 */
        this.disposers = new Map();
        this.lastTrace = [];
        this.registerDefaults();
    }

    /** 注册内置工具：注册这个动作本身，就是本场景的主角。 */
    registerDefaults() {
        this.disposers.set('get_weather', this.registry.register(new WeatherTool()));
        this.disposers.set('calculator', this.registry.register(new CalculatorTool()));
        this.disposers.set('get_time', this.registry.register(new TimeTool()));
    }

    name() {
        return 'Step11 · 工具注册表（ToolDefinition 协议）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.lastTrace.push({
            type: 'tool', label: '注册表就绪',
            detail: '当前 ' + this.registry.size() + ' 个工具，清单由注册表自动生成，无需改提示词代码',
        });

        // ---- 本地指令 1：查看工具清单（不经过模型，直接看注册表） ----
        if (input.includes('查看工具') || input.includes('工具清单')) {
            this.lastTrace.push({
                type: 'prompt', label: '工具清单 promptCatalog()',
                detail: this.registry.promptCatalog().trim(),
            });
            return '当前注册表中共有 ' + this.registry.size() + ' 个工具：\n' + this.registry.promptCatalog()
                + '\n这份清单就是模型每次对话时在系统提示词里「看见」的内容 —— 注册即生效，卸载即消失。';
        }

        // ---- 本地指令 2：卸载工具（演示注销器） ----
        if (input.startsWith('卸载：') || input.startsWith('卸载:')) {
            const name = input.substring(3).trim();
            const d = this.disposers.get(name);
            this.disposers.delete(name);
            if (d == null) {
                return '工具 ' + name + ' 不在注册表中，无法卸载。当前清单：\n' + this.registry.promptCatalog();
            }
            d();
            this.lastTrace.push({
                type: 'guard', label: '注销器执行 disposer.run()',
                detail: '工具 ' + name + ' 已从注册表摘除，剩余 ' + this.registry.size() + ' 个',
            });
            return '已卸载工具 ' + name + '。注销器（disposer）就是注册时返回的函数 —— '
                + '插件停止/卸载时，宿主正是靠它回收工具、系统提示词等注册项。\n当前清单：\n' + this.registry.promptCatalog()
                + '\n现在再问相关问题，模型将「看不见」这个工具。';
        }

        // ---- 常规对话：清单进提示词 → 模型决策 → 注册表执行 ----
        const messages = [
            Message.system(SYSTEM_PROMPT_PREFIX + this.registry.promptCatalog()
                + '\n决策规则：\n- 需要工具时，只输出 JSON：{"tool": "工具名", "arguments": {"参数名": "值"}}\n'
                + '- 不需要工具时，直接用自然语言回答，不要输出 JSON。'),
            Message.user(input),
        ];

        // 最多 2 轮：工具调用 → 结果回填 → 最终回答（与 Step04 同构，但执行走注册表）
        for (let round = 1; round <= 2; round++) {
            const raw = (await this.model.chat(messages)).trim();
            const decision = tryParse(raw);

            if (decision && typeof decision === 'object' && str(decision, 'tool') != null) {
                const toolName = decision.tool;
                this.lastTrace.push({
                    type: 'action', label: '模型发起工具调用',
                    detail: toolName + ' ' + JSON.stringify(decision.arguments),
                });

                // 核心差异：执行器不认识任何具体工具，只查注册表
                const tool = this.registry.lookup(toolName);
                let result;
                if (tool == null) {
                    result = '未知工具: ' + toolName + '。可用清单：\n' + this.registry.promptCatalog();
                    this.lastTrace.push({
                        type: 'guard', label: '注册表未命中',
                        detail: '模型只能调用注册表里存在的工具 —— 卸载后的工具自然不可调用',
                    });
                } else {
                    try {
                        result = await tool.execute(decision.arguments ?? {});
                    } catch (e) {
                        result = '工具执行失败: ' + e.message;
                    }
                    this.lastTrace.push({ type: 'observation', label: '注册表执行 ' + toolName, detail: result });
                }

                messages.push(Message.assistant(raw));
                messages.push(Message.user('工具 ' + toolName + ' 执行结果: ' + result));
                continue;
            }

            // 模型直接给出自然语言回答
            this.lastTrace.push({
                type: 'final', label: '最终回答',
                detail: '模型基于注册表提供的工具完成决策',
            });
            return raw;
        }
        return '已达最大轮数，循环终止。';
    }

    reset() {
        this.registry.clear();
        this.disposers.clear();
        this.registerDefaults();
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
        return raw;
    }
}
