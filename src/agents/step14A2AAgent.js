import { randomUUID } from 'node:crypto';
import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step14 · A2A 协作 —— 代理之间的「标准化网络协议」
 * （对应 deepseek-harness-java 的 A2AController / AgentCard / CollaborationController）。
 *
 * Step12/23 的多代理都活在同一个进程里，主代理直接 new 出子代理。
 * A2A（Agent-to-Agent）解决的是跨进程、跨主人的协作：
 * - 名片发现（Agent Card）：每个代理对外公布一份 JSON 名片 —— 我是谁、住在哪个 URL、会什么技能；
 * - 标准化请求：协作不靠猜接口，靠统一信封 —— 任务描述 + task_id + 状态机
 *   （submitted → working → completed/failed）；
 * - 异步回执：发起方拿到 task_id 即可离开，结果异步取回。
 *
 * 与 Step13 子代理的区别：子代理是自家分身（进程内、共享宿主模型）；
 * A2A 是外部同行（网络调用、对方有自己的模型与工具），类比：请同事帮忙 vs 外包给合作公司。
 *
 * 试试本场景的对话：
 *   发现一下附近的代理                    —— 拉取两张 Agent Card
 *   让翻译代理把「你好，智能体」翻译成英文  —— a2a_send 委派，返回 task_id + 回执
 *   问问天气代理明天适合户外运动吗         —— 按 skill 路由到天气代理
 */

/**
 * Agent Card（名片）：A2A 协议里的发现单元 ——
 * 生产中托管在 https://host/.well-known/agent.json，这里教学化简为对象。
 */
class AgentCard {
    constructor(name, url, version, skills, description) {
        this.name = name;
        this.url = url;
        this.version = version;
        this.skills = skills;
        this.description = description;
    }
}

const SYSTEM_PROMPT = `你是 ToyAgent 主代理，可通过 A2A 协议与外部代理协作。协作前先发现名片。
查看目录时只输出 JSON：{"tool": "a2a_discover"}
委派任务时只输出 JSON：{"tool": "a2a_send", "agent": "translator|weather", "task": "任务描述"}
翻译类任务派给 translator，天气类任务派给 weather。拿到结果后用自然语言回答。`;

export class A2AAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
        /** 本地目录：模拟网络上已注册的两个外部代理（真实实现是 HTTP 拉取名片）。 */
        this.DIRECTORY = new Map([
            ['translator', new AgentCard('translator', 'http://a2a.local/translator', '1.0.0',
                ['translate'], '中英互译代理')],
            ['weather', new AgentCard('weather', 'http://a2a.local/weather', '2.1.0',
                ['forecast'], '天气预报代理')],
        ]);
        /** 已发起的协作任务：id → 描述（生产中由 CollaborationController 持久化并轮询状态）。 */
        this.tasks = new Map();
        this.seq = 0;
    }

    name() {
        return 'Step14 · A2A 协作（Agent Card 名片发现 · task_id 信封 · 异步回执）';
    }

    async chat(input) {
        this.lastTrace = [];
        const messages = [
            Message.system(SYSTEM_PROMPT),
            Message.user(input),
        ];

        for (let round = 1; round <= 3; round++) {
            const raw = (await this.model.chat(messages)).trim();
            const decision = tryParse(raw);

            if (decision && typeof decision === 'object' && str(decision, 'tool') != null) {
                const tool = decision.tool;
                const result = tool === 'a2a_discover'
                    ? this.discover()
                    : this.send(str(decision, 'agent'), str(decision, 'task'));
                messages.push(Message.assistant(raw));
                messages.push(Message.user('工具执行结果: ' + result));
                continue;
            }

            this.lastTrace.push({ type: 'final', label: '最终回答', detail: '汇总协作结果，向用户作答' });
            return raw;
        }
        return '已达最大轮数，循环终止。';
    }

    /** a2a_discover：拉取目录里所有代理的名片（生产中 GET /.well-known/agent.json）。 */
    discover() {
        this.lastTrace.push({
            type: 'action', label: 'a2a_discover · 名片发现',
            detail: '拉取 ' + this.DIRECTORY.size + ' 份 Agent Card（模拟网络请求）',
        });
        let sb = '[';
        let i = 0;
        for (const c of this.DIRECTORY.values()) {
            if (i++ > 0) sb += ', ';
            sb += '\n  {"name": "' + c.name + '", "url": "' + c.url
                + '", "version": "' + c.version
                + '", "skills": ' + JSON.stringify(c.skills) + '}';
        }
        const cards = sb + '\n]';
        this.lastTrace.push({
            type: 'observation', label: '收到名片',
            detail: 'translator（中英互译） · weather（天气预报）',
        });
        return cards;
    }

    /** a2a_send：按名片路由委派请求，模拟 submitted → completed 状态机并回执。 */
    send(agent, task) {
        const card = this.DIRECTORY.get(agent);
        if (card == null) {
            this.lastTrace.push({
                type: 'guard', label: 'a2a_send · 路由失败',
                detail: '目录中没有 ' + agent + '，请先 a2a_discover',
            });
            return '{"error": "unknown agent: ' + agent + '"}';
        }
        const taskId = 'task-' + String(++this.seq).padStart(3, '0') + '-' + randomUUID().slice(0, 4);
        this.tasks.set(taskId, agent + ': ' + task);

        this.lastTrace.push({
            type: 'action', label: 'a2a_send · 发起协作',
            detail: '→ ' + card.name + ' @ ' + card.url + '  task=' + task,
        });
        this.lastTrace.push({
            type: 'thought', label: '状态机 · submitted → working',
            detail: '对方已受理 task_id=' + taskId + '（信封标准化：发起方只认 task_id，不关心对方内部实现）',
        });

        const reply = handleRemotely(card, task);
        this.lastTrace.push({
            type: 'observation', label: '回执 · completed',
            detail: 'task_id=' + taskId + ' 已完成：' + reply,
        });
        return '{"task_id": "' + taskId + '", "status": "completed", "result": "' + reply + '"}';
    }

    reset() {
        this.tasks.clear();
        this.seq = 0;
    }

    trace() {
        return [...this.lastTrace];
    }
}

/** 模拟远端代理按 skill 处理（真实实现：POST JSON-RPC / HTTP task 请求）。 */
function handleRemotely(card, task) {
    switch (card.name) {
        case 'translator': return '翻译结果（模拟远端模型）：Hello, Agent.';
        case 'weather': return '明日晴，22-28℃，东南风 3 级，适合户外运动（模拟远端数据）';
        default: return '（模拟远端响应）';
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
