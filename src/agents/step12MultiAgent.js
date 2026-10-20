import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step12 · 多智能体协作 —— 从一个大脑到一支团队。
 *
 * 单个智能体上下文有限、职责混杂。多智能体模式按角色拆分：
 * 规划者（Planner）拆解任务 → 专家（Worker）各司其职 →
 * 审查员（Reviewer）质量把关 → 主持者（Orchestrator）汇总交付。
 *
 * 每个角色都是一个独立的 ChatAgent 实例（不同的系统提示词），
 * 协作的本质是：结构化的消息在角色之间流动。
 */

export class MultiAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step12 · 多智能体协作（规划-执行-审查）';
    }

    async chat(input) {
        this.lastTrace = [];

        // 1. 规划者：拆解任务
        const planRaw = (await this.model.chat([
            Message.system(`你是规划者（Planner）。把用户任务拆解为三个角色的执行计划，只输出 JSON：
{"plan": [{"role": "研究员", "task": "..."}, {"role": "写手", "task": "..."}, {"role": "审查员", "task": "..."}]}
`),
            Message.user(input),
        ])).trim();
        const planObj = tryParse(planRaw);
        const plan = (planObj && typeof planObj === 'object' && Array.isArray(planObj.plan)) ? planObj.plan : [];
        this.lastTrace.push({
            type: 'agent',
            label: '🧭 规划者',
            detail: '产出 ' + plan.length + ' 步计划：' + describe(plan),
        });

        // 2. 研究员：收集素材
        const notes = await this.model.chat([
            Message.system('你是研究员（Researcher），围绕任务输出 3 条以内研究要点，每条一句话。'),
            Message.user(input),
        ]);
        this.lastTrace.push({ type: 'agent', label: '🔬 研究员', detail: clip(notes, 60) });

        // 3. 写手：基于素材成稿
        const draft = await this.model.chat([
            Message.system(`你是写手（Writer）。基于研究笔记写一段 100 字以内的短文，主题如下。
研究笔记: ${notes}
`),
            Message.user(input),
        ]);
        this.lastTrace.push({ type: 'agent', label: '✍️ 写手', detail: clip(draft, 60) });

        // 4. 审查员：质量把关
        const reviewRaw = (await this.model.chat([
            Message.system(`你是审查员（Reviewer）。审查短文，只输出 JSON：
{"pass": true/false, "comment": "一句话点评"}
`),
            Message.user(draft),
        ])).trim();
        const review = tryParse(reviewRaw);
        const pass = Boolean(review && typeof review === 'object' && review.pass);
        const comment = str(review, 'comment');
        this.lastTrace.push({
            type: pass ? 'guard' : 'warn',
            label: pass ? '✅ 审查员：通过' : '⚠️ 审查员：打回',
            detail: comment ?? '',
        });

        // 5. 主持者汇总交付
        const finalAnswer = pass
            ? draft
            : await this.model.chat([
                Message.system('根据审查意见修改短文，直接输出修改后的版本。'),
                Message.user('原文: ' + draft + '\n审查意见: ' + comment),
            ]);
        this.lastTrace.push({ type: 'final', label: '🏁 主持者汇总', detail: '协作链路：规划 → 研究 → 写作 → 审查 → 交付' });
        return finalAnswer;
    }

    trace() {
        return [...this.lastTrace];
    }
}

function describe(plan) {
    let sb = '';
    for (const o of plan) {
        if (o && typeof o === 'object') {
            sb += String(o.role) + '→';
        }
    }
    return sb.replace(/→$/, '');
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
