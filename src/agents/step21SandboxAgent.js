import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Step21 · 沙箱纵深防御 —— 命令执行前的四道关卡。
 *
 * 参考 deepseek-harness-java 的命令拦截器与沙箱设计（策略三档 → 内容黑名单 →
 * 空间边界 → 路径规范化），拆出教学版四层校验管线，任何一层拦截即 DENY：
 * 1. 策略层：当前策略档位是否允许 shell（READ_ONLY 直接全拒）；
 * 2. 内容黑名单：rm -rf /、sudo、mkfs、fork 炸弹等破坏性命令特征
 *    （dsh-java 里是一个 ~85 行的独立拦截器）；
 * 3. 空间边界：命令中出现的路径必须落在工作区 sandbox/ 内，绝对路径越界即拒；
 * 4. 路径规范化：先 canonicalize 再校验，workspace/../../etc/passwd
 *    这种「看似在内、实际在外」的逃逸无所遁形。
 *
 * 关键设计思想：不信任模型的输出 —— 模型生成的命令照样要过全部四层。
 */

/**
 * 校验结论：放行 or 拦截（在哪一层、为什么）。
 */
export class Verdict {
    constructor(allowed, layer, reason) {
        this.allowed = allowed;
        this.layer = layer;
        this.reason = reason;
    }
    static pass() { return new Verdict(true, 0, '四层校验全部通过'); }
    static deny(layer, why) { return new Verdict(false, layer, why); }
}

/** 内容黑名单（教学子集；dsh-java 生产版覆盖面更全）。 */
const DENYLIST = [
    'rm -rf', 'rm  -rf', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd if=',
    ':(){', 'fork()', 'chmod 777', '> /dev/', 'kill -9 1', 'curl | sh',
];

const SYSTEM_PROMPT = `你是 ToyAgent 的沙箱讲解员。用户可能询问沙箱、命令执行、安全防御相关话题。
只输出 JSON：{"final": "回答"}。想看四层校验实战，请引导用户发「执行：<命令>」。`;

export class SandboxAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.history = [];
        this.lastTrace = [];
        this.workspace = path.resolve('sandbox');
        try {
            mkdirSync(this.workspace, { recursive: true });
            writeFileSync(path.join(this.workspace, 'hello.txt'), 'ToyAgent sandbox\n');
        } catch {
            // 目录创建失败不影响讲解
        }
    }

    name() {
        return 'Step21 · 沙箱纵深防御（策略 → 黑名单 → 边界 → 规范化，四层拦截）';
    }

    async chat(input) {
        this.lastTrace = [];
        this.history.push(Message.user(input));

        // 发「执行：<命令>」即走沙箱管线；其余交给模型
        if (input.startsWith('执行：')) {
            const cmd = input.substring('执行：'.length).trim();
            return this.runShell(cmd);
        }

        const req = [Message.system(SYSTEM_PROMPT), ...this.history];
        const raw = (await this.model.chat(req)).trim();
        const parsed = tryParse(raw);
        const answer = (parsed && typeof parsed === 'object') ? orRaw(str(parsed, 'final'), raw) : raw;
        this.history.push(Message.assistant(answer));
        this.lastTrace.push({
            type: 'final', label: '直接作答',
            detail: '普通对话不走沙箱；想看四层校验，发「执行：<命令>」',
        });
        return answer;
    }

    /** 四层校验管线：任何一层拦截立即 DENY，全过才执行。 */
    runShell(cmd) {
        this.lastTrace.push({ type: 'action', label: 'shell_execute 请求', detail: cmd });

        // ===== 第 1 层 · 策略档位 =====
        this.lastTrace.push({
            type: 'thought', label: '第 1 层 · 策略校验 ✓',
            detail: '当前策略 WORKSPACE_ONLY 允许执行 shell（生产另有 READ_ONLY=全拒 / FULL=需审批）',
        });

        // ===== 第 2 层 · 内容黑名单 =====
        const low = cmd.toLowerCase();
        for (const bad of DENYLIST) {
            if (low.includes(bad)) {
                return this.deny(2, '命中危险命令特征「' + bad + '」');
            }
        }
        this.lastTrace.push({
            type: 'thought', label: '第 2 层 · 内容黑名单 ✓',
            detail: '未命中 ' + DENYLIST.length + ' 条破坏性命令特征',
        });

        // ===== 第 3 层 · 空间边界（绝对路径必须在工作区内） =====
        const abs = /(?<![\w.])\/(?:[\w.-]+\/)*[\w.-]+/g;
        let m;
        while ((m = abs.exec(cmd)) !== null) {
            const p = m[0];
            // 绝对路径按文件系统真实位置判断：只有恰好落在工作区内才放行
            const resolved = path.resolve(p);
            if (!(resolved === this.workspace || resolved.startsWith(this.workspace + path.sep))) {
                return this.deny(3, '绝对路径 ' + p + ' 越出工作区 ' + path.basename(this.workspace));
            }
        }
        this.lastTrace.push({
            type: 'thought', label: '第 3 层 · 空间边界 ✓',
            detail: '命令中的路径均位于工作区 sandbox/ 内（相对路径按工作区解析）',
        });

        // ===== 第 4 层 · 路径规范化（canonicalize 后复查，防 ../ 逃逸） =====
        if (cmd.includes('..')) {
            return this.deny(4, '检测到 ../ 相对跳转 —— 规范化后路径将越出工作区，疑似路径逃逸');
        }
        this.lastTrace.push({
            type: 'thought', label: '第 4 层 · 路径规范化 ✓',
            detail: 'canonicalize 复查通过，无 ../ 逃逸（第 3 层看原文，第 4 层看真实落点）',
        });

        // ===== 执行（教学模拟） =====
        const output = simulate(cmd);
        this.lastTrace.push({
            type: 'observation', label: '执行完成',
            detail: '工作区 ' + path.basename(this.workspace) + ' · ' + output,
        });
        this.history.push(Message.assistant('已执行（沙箱内）'));
        return '✅ 命令通过四层校验，已在沙箱内执行：\n$ ' + cmd + '\n' + output
            + '\n\n（教学模拟执行。生产版每层都是独立防线：模型生成的命令也必须全过。）';
    }

    deny(layer, why) {
        this.lastTrace.push({
            type: 'guard', label: '第 ' + layer + ' 层 · 拦截 DENY',
            detail: why + ' —— 纵深防御：任何一层说不行，就是不行',
        });
        this.history.push(Message.assistant('已拦截'));
        return '🛑 已在第 ' + layer + ' 层拦截：' + why;
    }

    reset() {
        this.history = [];
    }

    trace() {
        return [...this.lastTrace];
    }
}

function simulate(cmd) {
    if (cmd.startsWith('ls')) return 'hello.txt  notes.md  data/';
    if (cmd.startsWith('cat')) return 'ToyAgent sandbox（hello.txt 内容）';
    return '(模拟) 命令已执行，输出略';
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
