import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step13 · 子代理 —— 主智能体的「可派遣分身」（对应 dsh-java 的
 * SubagentRegistry / SubagentTool / SpawnInProcessProvider / ForkInProcessProvider）。
 *
 * 主代理不必亲自做所有事：把子任务委托给带独立上下文的子代理，结果回填主会话。
 * 两种派遣方式：
 * - spawn（SpawnInProcessProvider）：全新实例，只有职责提示词，看不到父会话 —— 适合无状态专项任务；
 * - fork（ForkInProcessProvider）：复制父会话上下文再出发 —— 适合「接着当前话题继续做」。
 *
 * 与 Step12 多智能体的区别：Step12 是固定流水线（规划→研究→写作→审查），角色间结构化协作；
 * 本步是主代理动态派遣 —— 模型自己决定派谁、派几个、带不带上下文，即 Claude Code 的 Task 工具。
 *
 * 试试本场景的对话（体会 spawn 与 fork 的上下文差异）：
 *   记住：我最喜欢紫色
 *   fork 一个子代理，让它写一句贺词      —— 子代理继承父会话，贺词里带紫色
 *   再 spawn 一个子代理写贺词           —— 全新实例，贺词里没有紫色
 *   派个研究员调研一下 Agent 趋势       —— spawn 专项任务
 */

/** 子代理档案：职责提示词（真实场景里每个子代理还可挂自己的工具集）。 */
const CHILDREN = new Map([
    ['researcher', '你是调研子代理。根据任务输出 3 条要点式调研结论，不写代码。'],
    ['writer', '你是写作子代理。根据任务输出一段 50 字以内的短文，不解释。'],
]);

const SYSTEM_PROMPT_PREFIX = `你是主智能体，可以把子任务委托给子代理。可用子代理：
- researcher：调研汇总
- writer：文案写作
派遣方式：spawn = 全新实例（无父会话上下文）；fork = 继承父会话上下文。
需要委托时只输出 JSON：{"tool": "dispatch_subagent", "name": "researcher", "mode": "spawn", "task": "子任务描述"}
不需要委托时，直接用自然语言回答，不要输出 JSON。
`;

export class SubagentAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        /** 父会话上下文：fork 时被子代理继承。 */
        this.parentTranscript = [];
        this.lastTrace = [];
    }

    name() {
        return 'Step13 · 子代理（spawn 独立上下文 / fork 继承上下文）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.parentTranscript.push('用户: ' + input);
        this.lastTrace.push({
            type: 'tool', label: '主代理就绪',
            detail: '可派遣子代理：' + [...CHILDREN.keys()] + '（父会话上下文 ' + this.parentTranscript.length + ' 条）',
        });

        const messages = [];
        const ctx = this.parentTranscript.length === 0 ? ''
            : '\n【父会话上下文】\n' + this.parentTranscript.join('\n');
        messages.push(Message.system(SYSTEM_PROMPT_PREFIX + ctx));
        messages.push(Message.user(input));

        for (let round = 1; round <= 3; round++) {
            const raw = (await this.model.chat(messages)).trim();
            const decision = tryParse(raw);

            if (decision && typeof decision === 'object' && str(decision, 'tool') != null) {
                const name = decision.name;
                const mode = decision.mode;
                const task = decision.task;
                this.lastTrace.push({
                    type: 'action', label: '主代理派遣子代理',
                    detail: 'subagent=' + name + '  mode=' + mode + '  task=' + task,
                });

                const result = await this.dispatch(name, mode, task);
                this.lastTrace.push({ type: 'observation', label: '子代理返回', detail: result });

                messages.push(Message.assistant(raw));
                messages.push(Message.user('子代理 ' + name + '(' + mode + ') 执行结果: ' + result));
                continue;
            }

            this.lastTrace.push({ type: 'final', label: '最终回答', detail: '主代理汇总子代理结果，向用户作答' });
            this.parentTranscript.push('助手: ' + raw);
            return raw;
        }
        return '已达最大轮数，循环终止。';
    }

    /** 派遣：spawn 给全新上下文；fork 复制父会话再出发。 */
    async dispatch(name, mode, task) {
        const specialty = CHILDREN.get(name);
        if (specialty == null) {
            return '没有叫 ' + name + ' 的子代理。可用：' + [...CHILDREN.keys()];
        }
        const fork = 'fork'.toLowerCase() === String(mode ?? '').toLowerCase();

        const childMessages = [];
        let sys = '【子代理身份】' + specialty;
        if (fork) {
            sys += '\n【继承的父会话上下文】\n' + this.parentTranscript.join('\n');
        } else {
            sys += '\n（spawn 模式：全新实例，看不到父会话）';
        }
        childMessages.push(Message.system(sys));
        childMessages.push(Message.user(task));

        const report = (await this.model.chat(childMessages)).trim();
        this.lastTrace.push({
            type: 'tool', label: '子代理运行（' + mode + '）',
            detail: name + ' 收到任务「' + task + '」，上下文 ' + (fork ? '继承父会话 ' + this.parentTranscript.length + ' 条' : '全新（0 条历史）'),
        });
        return report;
    }

    reset() {
        this.parentTranscript = [];
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
