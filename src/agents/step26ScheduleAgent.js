import { Agent } from '../agent.js';
import * as Message from '../llm/message.js';
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Step26 · 定时工具 —— 给智能体装上「时间维度」的行动能力
 * （对应 deepseek-harness-java 的 domain/tool/schedule 定时工具子域）。
 *
 * 之前的工具都是即时的：调用 → 执行 → 返回。定时工具把「什么时候做」
 * 也变成模型的决策对象：
 * - 一次性调度：n 秒后执行（setTimeout + delay）；
 * - 循环调度：每 n 秒执行一次（setInterval）；
 * - 任务管理：列出 / 取消，每个任务有 job_id。
 *
 * 关键工程点：HTTP 请求已经返回，任务却在未来执行 —— 所以触发结果不能塞进本次响应，
 * 要落盘（events/step26-tasks.jsonl，append-only 事件溯源，呼应 Step22）并在后续对话中汇报。
 * 这也是生产提醒/巡检类 Agent 的最小雏形。
 *
 * 试试本场景的对话：
 *   定时：5秒 提醒我喝水        —— 注册一次性任务，拿到 job_id
 *   任务列表                    —— 看到 pending；5 秒后再问就变 done
 *   循环：每10秒 报一次时        —— 周期任务，触发次数持续增长
 *   取消：job-2                 —— 摘掉循环任务
 *   完成了什么                  —— 汇报已触发任务（结果从事件日志读回）
 */

const EVENT_FILE = path.join('events', 'step26-tasks.jsonl');

const SYSTEM_PROMPT = `你是 ToyAgent 的定时工具讲解员。用户可能询问定时任务、调度、提醒、巡检等话题。
只输出 JSON：{"final": "回答"}。请引导用户试用：
「定时：5秒 提醒我喝水」「循环：每10秒 报一次时」「任务列表」「取消：job-1」「完成了什么」。`;

class Job {
    constructor(id, type, content, period, cancelFn) {
        this.id = id;
        this.type = type;
        this.content = content;
        this.period = period;
        this.cancelFn = cancelFn;
        this.fired = 0;
        this.done = false; // 一次性任务已触发 / 已取消
    }
}

export class ScheduleAgent extends Agent {

    constructor(model) {
        super();
        this.model = model;
        this.lastTrace = [];
        /** 调度任务表：job_id → Job（宿主退出即消亡，教学足够；生产用持久化调度器/延时队列）。 */
        this.jobs = new Map();
        /** 已触发记录（调度定时器与 chat 线程都会碰）。 */
        this.firedLog = [];
        this.seq = 0;
    }

    name() {
        return 'Step26 · 定时工具（一次性/循环调度 · 触发结果事件落盘）';
    }

    async chat(input) {
        this.lastTrace = [];

        // —— 定时指令（宿主直连路由，不经过模型） ——
        const once = input.match(/^定时：(\d+)\s*秒\s*(.*)$/);
        if (once) {
            return this.scheduleOnce(parseInt(once[1], 10), once[2].trim());
        }
        const loop = input.match(/^循环：每(\d+)\s*秒\s*(.*)$/);
        if (loop) {
            return this.scheduleRecurring(parseInt(loop[1], 10), loop[2].trim());
        }
        if (input.includes('任务列表')) {
            return this.listJobs();
        }
        if (input.startsWith('取消：')) {
            return this.cancel(input.substring(3).trim());
        }
        if (input.includes('完成了什么') || input.includes('已触发')) {
            return this.reportFired();
        }

        // —— 普通对话 → 模型讲解 ——
        const req = [Message.system(SYSTEM_PROMPT), Message.user(input)];
        const raw = (await this.model.chat(req)).trim();
        const parsed = tryParse(raw);
        const answer = (parsed && typeof parsed === 'object' && str(parsed, 'final') != null)
            ? parsed.final : raw;
        this.lastTrace.push({
            type: 'final', label: '讲解回答',
            detail: '试试「定时：5秒 提醒我喝水」「循环：每10秒 报一次时」「任务列表」「完成了什么」',
        });
        return answer;
    }

    /** 一次性调度：setTimeout + delay，到点执行 → 落盘事件。 */
    scheduleOnce(delaySeconds, content) {
        const id = 'job-' + (++this.seq);
        const job = new Job(id, '一次性', content, delaySeconds, null);
        const timer = setTimeout(() => this.fire(id, content), delaySeconds * 1000);
        job.cancelFn = () => clearTimeout(timer);
        this.jobs.set(id, job);
        this.lastTrace.push({
            type: 'action', label: 'schedule_task · 一次性注册',
            detail: id + '：' + delaySeconds + ' 秒后执行「' + content + '」',
        });
        this.lastTrace.push({
            type: 'thought', label: '异步语义',
            detail: '本次调用立即返回；任务在未来由事件循环执行，结果落盘 events/step26-tasks.jsonl',
        });
        return '⏰ 已注册一次性任务 ' + id + '：' + delaySeconds + ' 秒后「' + content + '」\n'
            + '本次请求已返回，任务到点后在后台执行并记录 —— 稍后问「完成了什么」看结果。';
    }

    /** 循环调度：setInterval（首延迟 = 周期），触发次数持续累计。 */
    scheduleRecurring(intervalSeconds, content) {
        const id = 'job-' + (++this.seq);
        const job = new Job(id, '循环', content, intervalSeconds, null);
        const timer = setInterval(() => this.fire(id, content), intervalSeconds * 1000);
        job.cancelFn = () => clearInterval(timer);
        this.jobs.set(id, job);
        this.lastTrace.push({
            type: 'action', label: 'schedule_recurring · 循环注册',
            detail: id + '：每 ' + intervalSeconds + ' 秒执行「' + content + '」（首次延迟 = 周期）',
        });
        return '🔁 已注册循环任务 ' + id + '：每 ' + intervalSeconds + ' 秒「' + content + '」\n'
            + '问「任务列表」看触发次数，问「完成了什么」看已触发内容，不需要时「取消：' + id + '」。';
    }

    /** 定时器回调：记录 + 落盘（append-only JSONL，事件溯源）。 */
    fire(id, content) {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        const time = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        this.firedLog.push(time + '  [' + id + '] ' + content);
        const job = this.jobs.get(id);
        if (job) {
            job.fired++;
            if (job.type === '一次性') job.done = true;
        }
        try {
            mkdirSync(path.dirname(EVENT_FILE), { recursive: true });
            appendFileSync(EVENT_FILE,
                '{"time":"' + time + '","job":"' + id + '","content":"' + content + '"}\n',
                'utf-8');
        } catch {
            // 落盘失败不影响内存记录
        }
    }

    listJobs() {
        let sb = '📋 定时任务：\n';
        for (const j of this.jobs.values()) {
            const status = j.done
                ? 'done/取消'
                : j.type === '循环' ? '循环中 · 已触发 ' + j.fired + ' 次'
                    : 'pending';
            sb += '  ' + j.id + ' · ' + j.type
                + ' · 每/' + j.period + '秒 · 「' + j.content
                + '」 · ' + status + '\n';
        }
        this.lastTrace.push({
            type: 'observation', label: '任务列表',
            detail: this.jobs.size + ' 个任务在册',
        });
        return sb.replace(/\n$/, '');
    }

    cancel(id) {
        const j = this.jobs.get(id);
        if (j == null) return '没有任务 ' + id + '。在册：' + [...this.jobs.keys()];
        j.cancelFn?.();
        j.done = true;
        this.lastTrace.push({
            type: 'guard', label: 'cancel_task · 取消',
            detail: id + ' 已停止（在册保留，状态 done/取消）',
        });
        return '🚫 已取消 ' + id + '（「' + j.content + '」不再触发）。';
    }

    reportFired() {
        const log = [...this.firedLog];
        this.lastTrace.push({
            type: 'observation', label: '已触发任务汇报',
            detail: log.length === 0 ? '暂无触发记录' : log.length + ' 条，事件已 append 到 ' + EVENT_FILE,
        });
        return '✅ 已触发的任务（事件日志 ' + EVENT_FILE + '，append-only）：\n'
            + (log.length === 0 ? '（暂无 —— 注册一个「定时：5秒 提醒我喝水」再来看看）' : log.join('\n'));
    }

    reset() {
        for (const j of this.jobs.values()) j.cancelFn?.();
        this.jobs.clear();
        this.firedLog = [];
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
