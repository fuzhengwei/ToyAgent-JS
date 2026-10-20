import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step07 · RAG 智能体 —— 检索增强生成。
 *
 * 模型的知识是静态的，私有知识它根本没见过。RAG 的思路：
 * 先把问题在知识库里检索出最相关的片段，再把片段作为"参考资料"
 * 塞进提示词，让模型"戴着资料说话"。回答有出处、知识可热更。
 *
 * 完整 RAG = 切分 → 向量化 → 相似检索 → 增强生成。本场景用
 * 关键词重合度模拟向量相似度（教学简化），骨架完全一致 ——
 * 换成 Embedding 检索即生产级实现。
 */

/** 私有知识库：真实系统存向量库，这里用内存文档集合演示。 */
const KNOWLEDGE = [
    'ToyAgent 是小傅哥的智能体教学项目，用 12 个渐进式场景讲清楚智能体实现，每个场景只有一个接口类。',
    '智能体 = 大模型（大脑）+ 工具（手脚）+ 记忆（延续）+ 循环（节拍）。ReAct 循环是智能体的经典执行模式。',
    'MCP（Model Context Protocol）是 Anthropic 提出的工具标准化协议，核心方法为 tools/list 与 tools/call，实现工具与智能体解耦。',
    'RAG（检索增强生成）先从知识库检索相关片段，再把片段注入提示词让模型基于事实回答，能缓解幻觉与知识过期问题。',
    'Function Calling 让模型输出结构化工具调用请求（工具名 + 参数），由外部程序执行后将结果回填给模型。',
    '上下文窗口是模型一次能处理的最大 Token 数，超出时需要用滑动窗口、摘要压缩等上下文工程手段保护关键信息。',
];

const SYSTEM_PROMPT = `你是知识库问答智能体。回答规则：
1. 优先依据【参考资料】回答，并标注来源编号如 [1]。
2. 资料不足以回答时，如实说"知识库中暂无相关内容"，禁止编造。
`;

export class RagAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step07 · RAG 检索增强生成';
    }

    async chat(input) {
        this.lastTrace = [];

        // 1. 检索：按关键词重合度给知识片段打分，取 Top2
        const ranked = KNOWLEDGE
            .map(text => ({ text, score: score(text, input) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 2);

        const hits = ranked.filter(h => h.score > 0);
        this.lastTrace.push({
            type: 'retrieve',
            label: '知识库检索',
            detail: hits.length === 0
                ? '未命中任何片段（得分均为 0）'
                : hits.map(h => Math.round(h.score * 100) + ' 分 · ' + clip(h.text, 30)).join(' ｜ '),
        });

        // 2. 增强：命中片段注入提示词；未命中则要求拒答
        const messages = [Message.system(SYSTEM_PROMPT)];
        if (hits.length > 0) {
            let ctx = '【参考资料】\n';
            for (let i = 0; i < hits.length; i++) {
                ctx += '[' + (i + 1) + '] ' + hits[i].text + '\n';
            }
            messages.push(Message.user(ctx));
        }
        messages.push(Message.user(input));

        // 3. 生成
        const answer = await this.model.chat(messages);
        this.lastTrace.push({
            type: 'final',
            label: '增强生成完成',
            detail: hits.length === 0 ? '模型按约定拒答' : '回答基于 ' + hits.length + ' 个知识片段',
        });
        return answer;
    }

    trace() {
        return [...this.lastTrace];
    }
}

/** 教学版相似度：字符 bigram 重合率。生产中替换为 Embedding 余弦相似度。 */
function score(text, query) {
    if (query.length < 2) return 0;
    const grams = new Set();
    for (let i = 0; i < query.length - 1; i++) grams.add(query.substring(i, i + 2));
    let hit = 0;
    for (const g of grams) {
        if (text.includes(g)) hit++;
    }
    return grams.size === 0 ? 0 : hit / grams.size;
}

function clip(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
}
