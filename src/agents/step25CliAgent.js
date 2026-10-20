import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Step25 · CLI 智能体 —— 把智能体装进终端（对应教程 ch18 · CLI Agent）。
 *
 * 形态变了，骨架不变：仍然是 Agent.chat(input)，只是外面套一层终端 REPL。
 * 1. 工具侧换执行器：run_command 直接执行 shell 命令，复用 Step21 的沙箱四层防御
 *    （拒绝名单 → 路径边界 → 命令白名单 → 受限工作区）；
 * 2. 工作目录即上下文：受限工作区 sandbox/step25/ 进入系统提示词，像终端会话一样有 cwd；
 * 3. 两种交互模式：交互式 REPL（默认）与非交互单命令 -p "任务"（Claude Code 同款）。
 *
 * 试试本场景的本地指令（Web 页面）：
 *   运行：ls              —— 沙箱内直接执行，轨迹展示四层防御
 *   运行：cat hello.txt   —— 读受限工作区文件
 *   运行：rm -rf /        —— 第①层拒绝名单拦截
 *   运行：cat /etc/passwd —— 第②层路径边界拦截
 *   列出工作区文件        —— 模型自主决策调用 run_command
 *
 * 终端形态：node src/main.js run step25 "<任务>"（单命令）
 */

const WORKSPACE = path.join('sandbox', 'step25');
/** 第①层：拒绝名单（无论是否在沙箱内，一律拒绝）。 */
const DENYLIST = new Set(['rm', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd', 'kill', 'pkill']);
/** 第③层：命令白名单 —— 只放行只读/无害命令。 */
const ALLOWLIST = new Set(['ls', 'pwd', 'echo', 'cat', 'date', 'wc']);

const SYSTEM_PROMPT_PREFIX = (workspace) => `你是一个运行在终端里的 CLI 智能体。当前受限工作区：${workspace}
可以调用 run_command 执行命令（沙箱受四层防御保护）。
`;

export class CliAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
        this.initWorkspace();
    }

    initWorkspace() {
        try {
            mkdirSync(WORKSPACE, { recursive: true });
            const hello = path.join(WORKSPACE, 'hello.txt');
            if (!existsSync(hello)) {
                writeFileSync(hello, '你好，这里是 ToyAgent 的受限工作区。\n', 'utf-8');
            }
        } catch {
            // 目录创建失败不影响对话
        }
    }

    name() {
        return 'Step25 · CLI 智能体（终端 REPL + 沙箱执行器）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.lastTrace.push({
            type: 'tool', label: '终端会话就绪',
            detail: '工作区 ' + WORKSPACE + ' 已进入系统提示词（cwd 上下文）',
        });

        // ---- 本地指令：运行：<cmd>（不经模型，直接看沙箱防御） ----
        if (input.startsWith('运行：') || input.startsWith('运行:')) {
            return this.execute(input.substring(3).trim());
        }

        // ---- 常规对话：模型自主决策是否调用 run_command ----
        const messages = [
            Message.system(SYSTEM_PROMPT_PREFIX(WORKSPACE)
                + '\n决策规则：\n- 需要执行命令时，只输出 JSON：{"tool": "run_command", "arguments": {"command": "命令"}}\n'
                + '- 不需要命令时，直接用自然语言回答，不要输出 JSON。'),
            Message.user(input),
        ];

        for (let round = 1; round <= 2; round++) {
            const raw = (await this.model.chat(messages)).trim();
            const decision = tryParse(raw);

            if (decision && typeof decision === 'object' && str(decision, 'tool') != null) {
                const argsObj = decision.arguments;
                const cmd = (argsObj && typeof argsObj === 'object' && argsObj.command != null)
                    ? String(argsObj.command) : '';
                this.lastTrace.push({ type: 'action', label: '模型发起命令执行', detail: cmd });
                const result = this.runGuarded(cmd);
                messages.push(Message.assistant(raw));
                messages.push(Message.user('工具 run_command 执行结果: ' + result));
                continue;
            }
            this.lastTrace.push({
                type: 'final', label: '最终回答',
                detail: 'CLI 形态：模型基于终端会话上下文完成回答',
            });
            return raw;
        }
        return '已达最大轮数，循环终止。';
    }

    /** 本地指令入口：同样走四层防御，但直接返回结果。 */
    execute(cmd) {
        const result = this.runGuarded(cmd);
        return '命令：' + cmd + '\n结果：\n' + result;
    }

    /** 四层防御（与 Step21 同构）：拒绝名单 → 路径边界 → 命令白名单 → 受限工作区。 */
    runGuarded(cmd) {
        if (cmd == null || cmd.trim() === '') return '（空命令）';

        // ① 拒绝名单：整个命令串里出现即拦截
        const lower = cmd.toLowerCase();
        for (const bad of DENYLIST) {
            if (lower.includes(bad)) {
                this.lastTrace.push({
                    type: 'guard', label: '第①层 · 拒绝名单',
                    detail: '命中 ' + bad + ' → 直接拒绝（高危命令无商量余地）',
                });
                return '已拦截：命令包含拒绝名单中的 ' + bad + '。';
            }
        }
        // ② 路径边界：.. 或绝对路径一律拒绝
        for (const token of cmd.split(/\s+/)) {
            if (token.includes('..') || token.startsWith('/')) {
                this.lastTrace.push({
                    type: 'guard', label: '第②层 · 路径边界',
                    detail: 'token ' + token + ' 越出受限工作区 → 拒绝',
                });
                return '已拦截：路径 ' + token + ' 越出受限工作区 ' + WORKSPACE + '。';
            }
        }
        // ③ 命令白名单：只放行只读/无害命令
        const head = cmd.split(/\s+/)[0];
        if (!ALLOWLIST.has(head)) {
            this.lastTrace.push({
                type: 'guard', label: '第③层 · 命令白名单',
                detail: head + ' 不在白名单 ' + [...ALLOWLIST] + ' 中 → 拒绝',
            });
            return '已拦截：命令 ' + head + ' 不在白名单中（教学沙箱只放行 ' + [...ALLOWLIST] + '）。';
        }
        // ④ 受限工作区：spawn 指定工作目录，命令按空格拆分（不经 shell，无管道/重定向）
        try {
            const parts = cmd.split(/\s+/);
            const p = spawnSync(parts[0], parts.slice(1), {
                cwd: WORKSPACE,
                encoding: 'utf-8',
                timeout: 5000,
            });
            const out = (p.stdout ?? '').trim();
            const code = p.status == null ? -1 : p.status;
            this.lastTrace.push({
                type: 'observation', label: '沙箱执行 ' + cmd,
                detail: 'cwd=' + WORKSPACE + '，退出码 ' + code,
            });
            return out === '' ? '（无输出）' : out;
        } catch (e) {
            return '执行失败: ' + e.message;
        }
    }

    reset() {
        this.initWorkspace();
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
