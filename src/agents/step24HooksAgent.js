import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';

/**
 * Step24 · Hooks 钩子体系 —— 挂在工具调用生命周期上的「插件化拦截点」
 * （对应 deepseek-harness-java 的 HookService / HookMatcher / HookOutputMerger）。
 *
 * 工具执行前后并不是「裸奔」的：宿主在两个生命周期点暴露钩子位，任何符合签名的钩子都能挂上去：
 * 1. before：工具执行前 —— 可拦截（DENY）或改写参数；
 * 2. after：工具执行后 —— 可改写输出（脱敏、过滤、追加告警）。
 *
 * 三个要素：Hook（钩子本体）+ 匹配规则（挂在哪类工具上，即 HookMatcher）+
 * 输出合并（多个 after 钩子按注册顺序依次加工，即 HookOutputMerger）。
 *
 * 关键设计思想：横切逻辑与工具解耦 —— 审计、脱敏、风控都不写进工具代码，
 * 挂钩即生效，摘钩即消失；工具作者对此无感知。
 *
 * 试试本场景的对话：
 *   查询：张三                          —— after 脱敏钩子把手机号/邮箱打码
 *   发送：给 13812345678 发 密码是123456 —— before 风控钩子直接拦截
 *   钩子：关  →  查询：张三              —— 摘掉钩子，明文裸奔，对比出钩子的价值
 *   钩子：开                            —— 挂回钩子
 *   审计日志                            —— before 审计钩子记下的每一次调用
 */

/**
 * 钩子本体：name 标识、phase 挂载点（before/after）、match 匹配的工具名（* = 全部）。
 * handler 返回 null = 不干预；返回 "DENY:原因" = 拦截；否则用返回值替换原内容。
 */
class Hook {
    constructor(name, phase, match, handler) {
        this.name = name;
        this.phase = phase;
        this.match = match;
        this.handler = handler;
    }
}

const SYSTEM_PROMPT = `你是 ToyAgent 的钩子讲解员。用户可能询问钩子（Hooks）、拦截、脱敏、审计等话题。
只输出 JSON：{"final": "回答"}。请引导用户试用：「查询：张三」「发送：给 13812345678 发 密码是123456」「钩子：关」「审计日志」。`;

export class HooksAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
        /** before 审计钩子的落点：生产中是审计库 / SIEM，教学中是内存列表。 */
        this.auditLog = [];
        this.hooks = [];
        this.enabled = true;
        this.installDefaultHooks();
    }

    /** 出厂自带三条钩子：审计（before/全部）、风控（before/发短信）、脱敏（after/全部）。 */
    installDefaultHooks() {
        this.hooks.push(new Hook('审计', 'before', ['*'], (tool, payload) => {
            const d = new Date();
            const p = n => String(n).padStart(2, '0');
            this.auditLog.push(p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
                + '  ' + tool + '  args=' + payload);
            return null; // 审计只记录，不干预
        }));
        this.hooks.push(new Hook('风控-敏感外发', 'before', ['send_sms'], (tool, payload) =>
            payload.includes('密码') || payload.includes('验证码')
                ? 'DENY:短信内容含「密码/验证码」等敏感信息，禁止外发'
                : null));
        this.hooks.push(new Hook('脱敏', 'after', ['*'], (tool, payload) => {
            let masked = payload.replace(/(1[3-9])\d{9}/g, '$1*********');
            masked = masked.replace(/([\w.]+)@([\w.]+)/g, (m0, g1, g2) => g1.charAt(0) + '***@' + g2);
            return masked === payload ? null : masked;
        }));
    }

    name() {
        return 'Step24 · Hooks 钩子体系（before 拦截/改写 · after 脱敏/审计，挂钩即生效）';
    }

    async chat(input) {
        this.lastTrace = [];

        // —— 钩子管理指令（宿主能力，不经过模型） ——
        if (input.startsWith('钩子：')) {
            this.enabled = input.includes('开');
            this.lastTrace.push({
                type: 'action', label: this.enabled ? '钩子已全部挂载' : '钩子已全部摘除',
                detail: '当前 ' + this.hooks.length + ' 条钩子（审计/风控/脱敏），enabled=' + this.enabled,
            });
            return this.enabled ? '✅ 钩子已挂回：' + this.hookList() : '⚠️ 钩子已全部摘除 —— 工具现在裸奔，注意对比接下来的输出。';
        }
        if (input.includes('审计日志')) {
            this.lastTrace.push({
                type: 'observation', label: '审计日志（before 钩子写入）',
                detail: this.auditLog.length === 0 ? '暂无记录' : this.auditLog.join('\n'),
            });
            return '📋 审计日志（before 钩子记录）：\n' + (this.auditLog.length === 0 ? '（暂无）' : this.auditLog.join('\n'));
        }

        // —— 工具调用指令 → 走钩子管线 ——
        if (input.startsWith('查询：')) {
            return this.runPipeline('query_user', JSON.stringify({ name: input.substring(3).trim() }),
                '{"name": "张三", "phone": "13812345678", "email": "zhangsan@example.com", "level": "VIP"}');
        }
        if (input.startsWith('发送：')) {
            const payload = input.substring(3).trim();
            const mobile = payload.match(/1[3-9]\d{9}/);
            const phone = mobile ? mobile[0] : '13800000000';
            return this.runPipeline('send_sms', JSON.stringify({ phone, message: payload }), '短信已提交网关，回执 ok');
        }

        // —— 普通对话 → 模型讲解 ——
        const req = [Message.system(SYSTEM_PROMPT), Message.user(input)];
        const raw = (await this.model.chat(req)).trim();
        const parsed = tryParse(raw);
        const answer = (parsed && typeof parsed === 'object' && str(parsed, 'final') != null)
            ? parsed.final : raw;
        this.lastTrace.push({
            type: 'final', label: '讲解回答',
            detail: '试试「查询：张三」「发送：给 13812345678 发 密码是123456」「钩子：关」',
        });
        return answer;
    }

    /** 钩子管线：before 链（审计/风控）→ 工具执行 → after 链（脱敏），任何 before 拦截即终止。 */
    runPipeline(tool, args, toolResult) {
        this.lastTrace.push({
            type: 'action', label: '工具调用 ' + tool,
            detail: '参数 ' + args,
        });

        // ===== before 钩子链 =====
        let payload = args;
        for (const h of this.matchHooks('before', tool)) {
            const out = h.handler(tool, payload);
            if (out != null && out.startsWith('DENY:')) {
                this.lastTrace.push({
                    type: 'guard', label: 'before · ' + h.name + ' → 拦截',
                    detail: out.slice(5) + ' —— 钩子在不改工具代码的前提下拦下调用',
                });
                return '🛑 工具 ' + tool + ' 被 before 钩子「' + h.name + '」拦截：' + out.slice(5);
            }
            if (out != null) {
                this.lastTrace.push({
                    type: 'thought', label: 'before · ' + h.name + ' → 改写参数',
                    detail: payload + '  →  ' + out,
                });
                payload = out;
            } else {
                this.lastTrace.push({
                    type: 'thought', label: 'before · ' + h.name + ' → 放行',
                    detail: '未干预（如审计钩子：只记录不改动）',
                });
            }
        }

        // ===== 工具执行（教学模拟） =====
        this.lastTrace.push({
            type: 'observation', label: '工具执行完成',
            detail: toolResult,
        });

        // ===== after 钩子链（输出合并：按注册顺序依次加工） =====
        let output = toolResult;
        for (const h of this.matchHooks('after', tool)) {
            const out = h.handler(tool, output);
            if (out != null) {
                this.lastTrace.push({
                    type: 'thought', label: 'after · ' + h.name + ' → 改写输出',
                    detail: '输出已加工（' + h.name + '）',
                });
                output = out;
            }
        }
        return '🔗 钩子管线执行完毕：\n最终输出：' + output
            + (this.enabled ? '\n（before 审计+风控 → 工具 → after 脱敏，按注册顺序依次生效）' : '');
    }

    /** HookMatcher：按挂载点 + 工具名匹配；enabled=false 时整条链路直通。 */
    matchHooks(phase, tool) {
        if (!this.enabled) return [];
        return this.hooks
            .filter(h => h.phase === phase)
            .filter(h => h.match.includes('*') || h.match.includes(tool));
    }

    hookList() {
        let sb = '';
        for (const h of this.hooks) {
            sb += h.phase + '·' + h.name + '(match=' + h.match + ') ';
        }
        return sb.trim();
    }

    reset() {
        this.auditLog = [];
        this.enabled = true;
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
