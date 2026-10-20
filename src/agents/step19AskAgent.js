import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step19 · 人工介入 —— ask_user_question：把「异步的人」翻译成「可等待的答复」。
 *
 * 参考 deepseek-harness-java 的 ask_user_question 工具（CompletableFuture 阻塞-唤醒）。
 * ToyAgent 是同步 HTTP 架构，教学版用同一思想的另一种实现：会话挂起 + 续答：
 * 1. 模型发现关键信息缺失时，调用 ask_user_question「工具」，turn 挂起，
 *    问题持久化在会话状态里返回给用户；
 * 2. 用户的下一条消息不再进模型，而是作为人工答复回填挂起的工具位，
 *    turn 恢复继续执行。
 *
 * 生产版的差别只在「等待」的实现：dsh-java 用 Future 阻塞住执行线程等人，
 * 教学版把等待摊开成两次请求 —— 人机协同的语义完全一致。
 */

const SYSTEM_PROMPT = `你是一个懂得「何时该问人」的智能体。
当任务缺少关键信息（如预订缺少出发地、时间），不要猜测，主动向人提问：
只输出 JSON：{"ask": "你的问题（含可选选项）"}
信息完整时直接完成任务，只输出 JSON：{"final": "最终答案"}。不要输出 JSON 以外内容。`;

export class AskAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.history = [];
        /** 挂起中的问题：非 null 表示 turn 暂停，等待人工答复。 */
        this.pendingQuestion = null;
        this.lastTrace = [];
    }

    name() {
        return 'Step19 · 人工介入（ask_user_question：提问挂起 → 答复续跑）';
    }

    async chat(input) {
        this.lastTrace = [];

        // ===== 分支一：有挂起问题 —— 本条输入是「人工答复」，不进模型 =====
        if (this.pendingQuestion != null) {
            const q = this.pendingQuestion;
            this.pendingQuestion = null;
            this.lastTrace.push({
                type: 'observation', label: '人工答复回填',
                detail: '挂起问题「' + q + '」收到答复：' + input
                    + '（生产版是 CompletableFuture 阻塞-唤醒，教学版把等待摊开成两次请求）',
            });
            this.history.push(Message.user('人工答复：' + input));

            const answer = await this.complete(q);
            this.history.push(Message.assistant(answer));
            return answer;
        }

        // ===== 分支二：正常对话 —— 模型可发起 ask_user_question =====
        this.history.push(Message.user(input));
        const req = [Message.system(SYSTEM_PROMPT), ...this.history];

        const raw = (await this.model.chat(req)).trim();
        const parsed = tryParse(raw);

        const question = (parsed && typeof parsed === 'object') ? str(parsed, 'ask') : null;
        if (question != null) {
            // 模型主动向人提问：挂起 turn，问题存入会话状态
            this.pendingQuestion = question;
            this.lastTrace.push({
                type: 'action', label: '调用 ask_user_question',
                detail: 'turn 挂起，等待人工答复 —— 「异步的人」被翻译成了「可等待的工具结果」',
            });
            this.lastTrace.push({
                type: 'guard', label: '会话挂起 PENDING_ASK',
                detail: '问题已持久化在会话状态（重启不丢），下一条消息将作为答复回填',
            });
            return question + '\n\n（直接回复即可，我会带着你的答复继续任务。）';
        }

        const answer = (parsed && typeof parsed === 'object') ? orRaw(str(parsed, 'final'), raw) : raw;
        this.lastTrace.push({ type: 'final', label: '直接作答', detail: '信息完整，无需人工介入' });
        this.history.push(Message.assistant(answer));
        return answer;
    }

    /** 答复回填后，带着完整信息让模型继续完成任务（turn 恢复）。 */
    async complete(question) {
        const req = [];
        req.push(Message.system(SYSTEM_PROMPT + '\n（此前你曾向用户提问「' + question
            + '」，用户已答复，见最后一条人工答复。现在信息完整，直接完成任务并作答。）'));
        req.push(...this.history);
        const raw = (await this.model.chat(req)).trim();
        const parsed = tryParse(raw);
        const fin = (parsed && typeof parsed === 'object') ? str(parsed, 'final') : null;
        this.lastTrace.push({
            type: 'final', label: 'turn 恢复 · 完成',
            detail: '人工答复注入上下文，任务继续执行 —— 人机协同闭环',
        });
        return (parsed && typeof parsed === 'object') ? orRaw(fin, raw) : raw;
    }

    reset() {
        this.history = [];
        this.pendingQuestion = null;
    }

    trace() {
        return [...this.lastTrace];
    }
}

function str(o, key) {
    return o != null && typeof o === 'object' ? o[key] : undefined;
}

function orRaw(v, raw) {
    return v == null || v.trim() === '' ? raw : v;
}

function tryParse(raw) {
    try {
        return JSON.parse(raw.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim());
    } catch {
        return raw;
    }
}
