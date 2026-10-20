import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * Step08 · LLM-Wiki 智能体 —— 知识编译与持久化。
 *
 * RAG 解决「检索」：每次提问都从头翻文档。LLM-Wiki 解决「沉淀」：
 * 项目知识（架构约定、代码规范、部署流程）被编译成结构化条目，
 * 持久保存、随启动加载、增量维护 —— 知识编译一次、持续复用，而非每次从头检索。
 * 思路源自 Andrej Karpathy 的 LLM-Wiki 提法（AGENTS.md / CLAUDE.md 即其工程形态）。
 *
 * 本场景：内置基础 Wiki（编译一次）；用户说「编译：主题：内容」即可新增条目，
 * 持久化到 wiki/user-wiki.md，重启不丢；提问时按相关度取条目注入提示词作答。
 * 教学版检索用字符 bigram 重合度模拟，换成 Embedding 即生产级实现。
 */

/** 基础 Wiki：项目知识，启动时编译一次（生产中来自仓库里的 AGENTS.md / CLAUDE.md）。 */
const BASE_WIKI = {
    '架构约定': 'ToyAgent 是零依赖教学项目：一个接口类就是一个智能体场景（step01-26），全部实现放在 Impl 内部类里，禁止引入第三方依赖；模型层统一走 ChatModel 接口。',
    '代码规范': 'Java 17 语法；类与核心方法必须有中文 Javadoc 说明教学意图；trace 事件用 type/label/detail 三段式；JSON 一律走自研 Json 工具类。',
    '部署流程': 'javac -d target/classes 编译后 java -cp target/classes cn.xiaofuge.ai.Application 启动，默认端口 8099，可用环境变量 TOY_AGENT_PORT 覆盖；前端静态资源在 web/ 目录由服务直接托管。',
    '业务规则': '配置只保存在各人浏览器 localStorage 随请求生效，服务端 config.properties 仅作默认兜底；未配置 API Key 时所有场景回落 Mock 演示模型。',
};

const USER_WIKI_FILE = path.join('wiki', 'user-wiki.md');

const SYSTEM_PROMPT = `你是项目 Wiki 问答智能体。回答规则：
1. 优先依据【项目 Wiki】的条目回答，并标注来源条目名，如（来源：架构约定）。
2. Wiki 条目不足以回答时，如实说"项目 Wiki 中暂无相关条目"，并提示可以用「编译：主题：内容」沉淀该知识。禁止编造。
`;

export class WikiAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
        /** 用户编译的增量条目（重启后从 wiki/user-wiki.md 恢复）。 */
        this.userWiki = new Map();
        this.loadUserWiki();
    }

    name() {
        return 'Step08 · LLM-Wiki 知识编译';
    }

    async chat(input) {
        this.lastTrace = [];

        // ---------------- 编译指令：把对话中的知识沉淀进 Wiki ----------------
        if (input.startsWith('编译：') || input.startsWith('编译:') || input.startsWith('记住：') || input.startsWith('记住:')) {
            return this.compile(input);
        }

        // ---------------- 加载 Wiki（启动编译一次 + 增量条目） ----------------
        const wiki = this.currentWiki();
        this.lastTrace.push({
            type: 'load',
            label: '加载项目 Wiki',
            detail: '共 ' + wiki.size + ' 个条目（内置 ' + Object.keys(BASE_WIKI).length + ' + 已编译 ' + this.userWiki.size + '），无需每次重新检索原始文档',
        });

        // ---------------- 相关条目选取（教学版 bigram 打分，生产换 Embedding） ----------------
        const ranked = [...wiki.entries()]
            .map(([topic, content]) => ({ topic, content, score: score(topic + content, input) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 2);
        const hits = ranked.filter(h => h.score > 0);
        this.lastTrace.push({
            type: 'retrieve',
            label: '命中条目',
            detail: hits.length === 0
                ? '无相关条目'
                : hits.map(h => h.topic + '（' + Math.round(h.score * 100) + ' 分）').join(' ｜ '),
        });

        // ---------------- 增强生成 ----------------
        const messages = [Message.system(SYSTEM_PROMPT)];
        if (hits.length > 0) {
            let ctx = '【项目 Wiki】\n';
            for (const h of hits) {
                ctx += '◆ ' + h.topic + '：' + h.content + '\n';
            }
            messages.push(Message.user(ctx));
        }
        messages.push(Message.user(input));

        const answer = await this.model.chat(messages);
        this.lastTrace.push({
            type: 'final',
            label: '基于 Wiki 作答完成',
            detail: hits.length === 0 ? '模型按约定提示可编译新条目' : '回答基于 ' + hits.length + ' 个 Wiki 条目',
        });
        return answer;
    }

    /** 编译：解析「编译：主题：内容」，写入 Wiki 并持久化。 */
    compile(input) {
        const body = input.substring(3).trim(); // 去掉前缀「编译：/记住：」（等宽 3 字符）
        let sep = body.indexOf('：');
        if (sep < 0) sep = body.indexOf(':');
        if (body === '' || sep <= 0 || sep === body.length - 1) {
            this.lastTrace.push({ type: 'compile', label: '编译失败', detail: '格式：编译：主题：内容' });
            return '编译格式不对哦。请用：「编译：主题：内容」，例如「编译：发布流程：每周三灰度，周五全量上线」。';
        }
        const topic = body.substring(0, sep).trim();
        const content = body.substring(sep + 1).trim();
        const update = this.userWiki.has(topic);
        this.userWiki.set(topic, content);
        this.persistUserWiki();

        this.lastTrace.push({
            type: 'compile',
            label: update ? '更新条目' : '新增条目',
            detail: '◆ ' + topic + '（已持久化到 ' + USER_WIKI_FILE + '，重启不丢）',
        });
        this.lastTrace.push({
            type: 'final',
            label: '知识编译完成',
            detail: 'Wiki 现有 ' + this.currentWiki().size + ' 个条目，后续提问直接复用',
        });
        return '已编译进项目 Wiki：◆ ' + topic + '\n\n' + content + '\n\n之后所有提问都会带上这条知识（已持久化，重启不丢）。试试问我相关内容。';
    }

    currentWiki() {
        const all = new Map();
        for (const [k, v] of Object.entries(BASE_WIKI)) all.set(k, v);
        for (const [k, v] of this.userWiki) all.set(k, v);
        return all;
    }

    /** 持久化用户编译条目（教学版写本地 markdown；生产中提交到代码仓库）。 */
    persistUserWiki() {
        try {
            mkdirSync(path.dirname(USER_WIKI_FILE), { recursive: true });
            let sb = '# ToyAgent 用户 Wiki（由页面编译生成）\n\n';
            for (const [k, v] of this.userWiki) sb += '## ' + k + '\n' + v + '\n\n';
            writeFileSync(USER_WIKI_FILE, sb, 'utf-8');
        } catch (e) {
            console.error('[ToyAgent] 写入 user-wiki 失败: ' + e.message);
        }
    }

    loadUserWiki() {
        if (!existsSync(USER_WIKI_FILE)) return;
        try {
            const lines = readFileSync(USER_WIKI_FILE, 'utf-8').split(/\r?\n/);
            let topic = null;
            let content = '';
            for (const line of lines) {
                if (line.startsWith('## ')) {
                    if (topic != null) this.userWiki.set(topic, content.trim());
                    topic = line.substring(3).trim();
                    content = '';
                } else if (topic != null && !line.startsWith('#')) {
                    content += line + '\n';
                }
            }
            if (topic != null) this.userWiki.set(topic, content.trim());
            if (this.userWiki.size > 0) {
                console.log('[ToyAgent] 已从 ' + USER_WIKI_FILE + ' 恢复 ' + this.userWiki.size + ' 个编译条目');
            }
        } catch (e) {
            console.error('[ToyAgent] 读取 user-wiki 失败: ' + e.message);
        }
    }

    reset() {
        this.userWiki.clear();
        try {
            if (existsSync(USER_WIKI_FILE)) unlinkSync(USER_WIKI_FILE);
        } catch {
            // 删除失败不影响会话
        }
        this.lastTrace = [];
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
