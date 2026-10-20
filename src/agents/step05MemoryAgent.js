import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step05 · 记忆智能体 —— 让对话"有来有回"。
 *
 * Step01 每轮都是失忆的。本场景引入短期记忆：把历史消息一并放进
 * 上下文窗口发给模型。当历史超过阈值时，用"摘要压缩"保护窗口 ——
 * 滑动窗口 + 摘要，就是上下文工程（Context Engineering）的基础盘。
 *
 * 记忆的本质不是数据库，而是：每一次请求，都带上该带的历史。
 */

/** 保留的最大历史轮数（一条 user + 一条 assistant 算一轮）。 */
export const MAX_ROUNDS = 4;

const SYSTEM_PROMPT = `你是一个有记忆的聊天智能体。请基于"对话历史 + 压缩摘要 + 新输入"回答，
用户提到的个人信息（如名字）要在后续对话中保持一致。
`;

export class MemoryAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.history = [];
        this.summary = '';
        this.lastTrace = [];
    }

    name() {
        return 'Step05 · 记忆系统（多轮记忆 + 上下文压缩）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.history.push(Message.user(input));

        // 历史超限 → 压缩：把最旧的两轮合并为一条摘要
        if (this.history.length > MAX_ROUNDS * 2) {
            this.compress();
        }

        // 组装上下文：系统提示词 + 摘要 + 历史
        const context = [];
        context.push(Message.system(SYSTEM_PROMPT));
        if (this.summary !== '') {
            context.push(Message.system('【历史摘要】' + this.summary));
        }
        context.push(...this.history);

        this.lastTrace.push({
            type: 'memory',
            label: '记忆窗口',
            detail: '携带 ' + this.history.length + ' 条历史消息' + (this.summary === '' ? '' : ' + 1 条压缩摘要'),
        });

        const answer = await this.model.chat(context);
        this.history.push(Message.assistant(answer));

        this.lastTrace.push({
            type: 'final',
            label: '回答完成',
            detail: '本条回答同时看到：系统提示词' + (this.summary === '' ? '' : ' + 摘要') + ' + 全部历史 + 新输入',
        });
        return answer;
    }

    /** 上下文压缩：把最旧两轮摘成一句话，历史重新滑窗。 */
    compress() {
        const old1 = this.history.shift();
        const old2 = this.history.shift();
        const digest = clip(old1.content) + '；随后助手回答了 ' + clip(old2.content);
        this.summary = this.summary === '' ? digest : this.summary + ' → ' + digest;
        this.lastTrace.push({
            type: 'compress',
            label: '触发上下文压缩',
            detail: '最旧 2 轮已摘要化，摘要长度 ' + this.summary.length + ' 字符',
        });
    }

    reset() {
        this.history = [];
        this.summary = '';
    }

    trace() {
        return [...this.lastTrace];
    }
}

function clip(s) {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > 40 ? one.slice(0, 40) + '…' : one;
}
