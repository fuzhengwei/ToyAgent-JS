import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * Step22 · 事件溯源 —— 会话即日志，日志即状态。
 *
 * 参考 deepseek-harness-java 的 Session Event Log：16 种领域事件 + JSONL
 * append-only 存储 + 回放投影。教学版拆出三件套：
 * 1. 事件追加：会话中发生的每件事（用户发言/Agent 回答/回合完成）
 *    都是一条不可变事件，append 到 JSONL 文件，永不改写历史；
 * 2. 回放投影：每次对话前从日志重放全部事件，重建出会话上下文 ——
 *    Agent 的「记忆」不是内存里的 Array，而是从日志投影出来的视图；
 *    服务重启后状态从日志完整恢复（试试：聊两轮 → 重启进程 → 还记得你名字）；
 * 3. 审计能力：因为历史=事件流，天然获得审计、时间旅行、fork 会话等
 *    衍生能力（dsh-java 的子代理 fork 就是复制事件前缀）。
 *
 * 事件日志在 events/step22-events.jsonl，可直接打开查看每一条。
 */

/** 事件类型（教学子集；dsh-java 有 16 种 sealed 领域事件）。 */
export const EV_SESSION = 'SESSION_STARTED';
export const EV_USER = 'USER_MESSAGE_APPENDED';
export const EV_AGENT = 'AGENT_REPLY_APPENDED';
export const EV_TURN = 'TURN_COMPLETED';

const LOG_FILE = path.join('events', 'step22-events.jsonl');

const SYSTEM_PROMPT = `你是一个跑在事件溯源架构上的智能体：你的每次对话都会作为事件写入 JSONL 日志，
每轮开始前从日志回放重建记忆。像正常助手一样回答即可（记住用户告诉你的信息）。
只输出 JSON：{"final": "回答"}。`;

export class EventSourcedAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
    }

    name() {
        return 'Step22 · 事件溯源（JSONL 事件日志 + 回放投影重建会话）';
    }

    async chat(input) {
        this.lastTrace = [];
        try {
            // ===== 1. 回放：从日志重建会话状态 =====
            const log = this.replay();
            this.lastTrace.push({
                type: 'thought', label: '事件回放投影',
                detail: '从 ' + LOG_FILE + ' 重放 ' + log.length + ' 条事件，重建会话上下文'
                    + (log.length === 0 ? '（空日志 → 新会话）' : ''),
            });

            // ===== 2. 追加本轮事件 =====
            if (log.length === 0) this.append(EV_SESSION, { scenario: 'step22' });
            this.append(EV_USER, { content: input });

            // ===== 3. 上下文 = 投影结果（不是内存 Array！）=====
            const context = this.project(this.replay());
            const req = [];
            req.push(Message.system(SYSTEM_PROMPT + '（当前事件日志共 ' + log.length + ' 条）'));
            req.push(...context);

            const raw = (await this.model.chat(req)).trim();
            const parsed = tryParse(raw);
            const answer = (parsed && typeof parsed === 'object') ? orRaw(str(parsed, 'final'), raw) : raw;

            this.append(EV_AGENT, { content: answer });
            this.append(EV_TURN, { events: log.length + 3 });
            this.lastTrace.push({
                type: 'final', label: '本轮事件已落盘',
                detail: '追加 4 条事件（含会话首条）：USER → AGENT_REPLY → TURN_COMPLETED。'
                    + '日志 append-only 永不改写，历史即事件流',
            });
            return answer;
        } catch (e) {
            return '事件日志读写失败：' + e.message;
        }
    }

    /** 回放：逐行读 JSONL（append-only，所以重放顺序 = 发生顺序）。 */
    replay() {
        this.ensureFile();
        const log = [];
        for (const line of readFileSync(LOG_FILE, 'utf-8').split(/\r?\n/)) {
            if (line.trim() === '') continue;
            try {
                log.push(JSON.parse(line));
            } catch {
                // 损坏行跳过 —— append-only + 校验和是生产标配，教学从简
            }
        }
        return log;
    }

    /** 投影：事件流 → 会话上下文（只挑 USER / AGENT 两类，其余事件服务审计）。 */
    project(log) {
        const history = [];
        for (const e of log) {
            const type = String(e.type);
            const content = String((e.payload ?? {}).content);
            switch (type) {
                case EV_USER: history.push(Message.user(content)); break;
                case EV_AGENT: history.push(Message.assistant(content)); break;
                default: /* SESSION_STARTED / TURN_COMPLETED 不进上下文，但留在日志里 */ break;
            }
        }
        return history;
    }

    /** 追加一条事件：seq 单调递增，一行一条 JSON。 */
    append(type, payload) {
        this.ensureFile();
        const seq = readFileSync(LOG_FILE, 'utf-8').split(/\r?\n/).filter(l => l.trim() !== '').length + 1;
        const event = {
            seq,
            ts: Date.now(),
            type,
            payload,
        };
        appendFileSync(LOG_FILE, JSON.stringify(event) + '\n', 'utf-8');
    }

    ensureFile() {
        if (!existsSync(LOG_FILE)) {
            mkdirSync(path.dirname(LOG_FILE), { recursive: true });
            writeFileSync(LOG_FILE, '', 'utf-8');
        }
    }

    reset() {
        this.lastTrace = [];
        try {
            if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
        } catch {
            // 删除失败不影响会话
        }
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
