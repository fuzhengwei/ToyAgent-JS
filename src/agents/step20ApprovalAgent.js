import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step20 · 审批门禁 —— 高危操作先过人，批准才放行。
 *
 * 参考 deepseek-harness-java 的运行期审批链路（提交期权限矩阵 + 高危工具人工审批），
 * 拆出四个教学点：
 * 1. 风险分级：每个工具声明风险等级，安全工具（只读）自动放行，
 *    高危工具（写文件/发邮件/执行命令）必须过门禁；
 * 2. 三档模式：AUTO_MANUAL_SAFE（本场景默认）/ ALWAYS_ASK / FULL_AUTO，决定门禁松紧；
 * 3. 会话级免审记忆：「批准并记住」后，同工具本会话内自动放行 —— 信任一次，不再重复打扰；
 * 4. 超时默认 DENY：生产里审批有超时，超时即拒绝（宁可不执行，不可乱执行）。
 */

/** 审批模式三档。 */
export const Mode = {
    AUTO_MANUAL_SAFE: 'AUTO_MANUAL_SAFE',  // 安全自动放行，高危问人（默认）
    ALWAYS_ASK: 'ALWAYS_ASK',              // 一切外部动作都要审批
    FULL_AUTO: 'FULL_AUTO',                // 全自动（仅教学演示，生产慎用）
};

const SYSTEM_PROMPT = `你是一个接入了多种工具的智能体。可用工具：
- get_weather(city)：查天气【安全·只读】
- send_email(to, content)：发邮件【高危·写操作】
- delete_file(path)：删文件【高危·写操作】
需要工具时只输出 JSON：{"tool": "工具名", "arguments": "参数摘要"}
无需工具时只输出 JSON：{"final": "最终答案"}。不要输出 JSON 以外内容。`;

export class ApprovalAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.history = [];
        /** 会话级免审名单：批准并记住的高危工具。 */
        this.trustedTools = new Set();
        /** 挂起中的审批请求。 */
        this.pendingTool = null;
        this.pendingArgs = null;
        this.mode = Mode.AUTO_MANUAL_SAFE;
        this.lastTrace = [];
    }

    name() {
        return 'Step20 · 审批门禁（高危操作先过人：批准 / 拒绝 / 批准并记住）';
    }

    async chat(input) {
        this.lastTrace = [];

        // ===== 分支一：有挂起审批 —— 本条输入是人的决策，不进模型 =====
        if (this.pendingTool != null) {
            const tool = this.pendingTool;
            const args = this.pendingArgs;
            this.pendingTool = null;
            return this.resolveApproval(tool, args, input);
        }

        // ===== 分支二：正常对话 =====
        this.history.push(Message.user(input));
        return this.decideAndAct(input);
    }

    async decideAndAct(input) {
        const req = [Message.system(SYSTEM_PROMPT), ...this.history];

        const raw = (await this.model.chat(req)).trim();
        const parsed = tryParse(raw);
        if (parsed == null || typeof parsed !== 'object') {
            this.history.push(Message.assistant(raw));
            this.lastTrace.push({ type: 'final', label: '直接作答', detail: '无工具需求' });
            return raw;
        }

        const tool = str(parsed, 'tool');
        if (tool == null) {
            const answer = orRaw(str(parsed, 'final'), raw);
            this.history.push(Message.assistant(answer));
            this.lastTrace.push({ type: 'final', label: '直接作答', detail: '无需工具' });
            return answer;
        }

        const args = parsed.arguments == null ? '' : String(parsed.arguments);
        this.lastTrace.push({ type: 'action', label: '模型发起工具调用', detail: tool + ' ' + args });

        // ===== 权限评估：风险分级 + 模式 + 会话免审记忆 =====
        const dangerous = isDangerous(tool);
        const needAsk = this.mode === Mode.ALWAYS_ASK
            || (this.mode === Mode.AUTO_MANUAL_SAFE && dangerous && !this.trustedTools.has(tool));
        this.lastTrace.push({
            type: 'thought', label: '权限矩阵评估',
            detail: tool + ' → ' + (dangerous ? '高危' : '安全')
                + ' · 模式 ' + this.mode + (this.trustedTools.has(tool) ? ' · 命中会话免审' : ''),
        });

        if (needAsk) {
            this.pendingTool = tool;
            this.pendingArgs = args;
            this.lastTrace.push({
                type: 'guard', label: '审批挂起 PENDING_APPROVAL',
                detail: '高危操作等待人工决策。生产版有审批超时 —— 超时默认 DENY，宁可不执行',
            });
            return '⚠️ 即将执行高危操作：' + tool + '\n参数：' + args + '\n\n'
                + '请回复：「批准」执行 ｜「拒绝」取消 ｜「批准并记住」本会话内该工具免审';
        }

        const result = execute(tool, args);
        this.lastTrace.push({
            type: 'observation', label:
                this.trustedTools.has(tool) && dangerous ? '自动放行（会话免审）' : '自动放行（安全工具）',
            detail: result,
        });
        return this.finish(tool, result);
    }

    /** 处理人的审批决策。 */
    async resolveApproval(tool, args, decision) {
        const d = decision.trim();
        if (d.startsWith('批准并记住')) {
            this.trustedTools.add(tool);
            this.lastTrace.push({
                type: 'guard', label: '人工决策 · 批准并记住',
                detail: tool + ' 加入会话级免审名单，本会话后续调用自动放行',
            });
        } else if (d.startsWith('批准')) {
            this.lastTrace.push({
                type: 'guard', label: '人工决策 · 批准',
                detail: '仅本次放行，下次仍会询问',
            });
        } else if (d.startsWith('拒绝')) {
            this.lastTrace.push({
                type: 'guard', label: '人工决策 · 拒绝',
                detail: '高危操作被拦截，任务终止（生产版超时未审批同样按 DENY 处理）',
            });
            this.history.push(Message.user('审批结果：' + tool + ' 被拒绝'));
            return '已拒绝执行 ' + tool + '。操作未发生 —— 审批门禁的意义就在于：人的否决权永远在模型之上。';
        } else {
            this.pendingTool = tool;
            this.pendingArgs = args;
            this.lastTrace.push({
                type: 'guard', label: '无法识别的决策',
                detail: '审批仍挂起，请回复：批准 / 拒绝 / 批准并记住',
            });
            return '没看懂你的决定。请回复：「批准」｜「拒绝」｜「批准并记住」';
        }
        const result = execute(tool, args);
        this.lastTrace.push({ type: 'observation', label: '审批放行 · 执行', detail: result });
        this.history.push(Message.user('审批结果：' + tool + ' 已批准并执行'));
        return this.finish(tool, result);
    }

    /** 工具执行后，让模型基于结果收尾。 */
    async finish(tool, result) {
        const req = [];
        req.push(Message.system(SYSTEM_PROMPT + '\n（工具 ' + tool + ' 的执行结果：' + result + '。请据此作答。）'));
        req.push(...this.history);
        const raw = (await this.model.chat(req)).trim();
        const parsed = tryParse(raw);
        const answer = (parsed && typeof parsed === 'object') ? orRaw(str(parsed, 'final'), raw) : raw;
        this.history.push(Message.assistant(answer));
        return answer;
    }

    // -------------------------------------------------------------- 风险与执行

    reset() {
        this.history = [];
        this.trustedTools.clear();
        this.pendingTool = null;
        this.pendingArgs = null;
    }

    trace() {
        return [...this.lastTrace];
    }
}

/** 风险分级：写出去的操作都是高危，只读是安全。 */
function isDangerous(tool) {
    return ['send_email', 'delete_file', 'shell_execute', 'publish_article'].includes(tool);
}

/** 模拟执行（教学：不真发邮件、不真删文件）。 */
function execute(tool, args) {
    switch (tool) {
        case 'send_email': return '已发送（模拟）：' + args;
        case 'delete_file': return '已删除（模拟）：' + args;
        case 'get_weather': return '晴，26℃（模拟数据）';
        default: return '已执行（模拟）：' + args;
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
