import { Clock3, Plus, Workflow } from "lucide-react";
import { useState } from "react";
import { Button, EmptyState, InlineNotice, StatusPill } from "../components.js";
import { useRuntime } from "../runtime-context.js";
import { formatRelative } from "../view-format.js";

export function AutomationsPage() {
  const { data, actions, busy } = useRuntime();
  const [creating, setCreating] = useState(false);
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">后台任务</span>
          <h2>定时任务</h2>
          <p>让 Pico 按计划重复执行任务；审批与信任规则始终有效。</p>
        </div>
        <Button variant="primary" onClick={() => setCreating((value) => !value)}>
          <Plus aria-hidden="true" size={16} />
          新建定时任务
        </Button>
      </section>
      {creating && (
        <form
          className="automation-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const name = form.get("name");
            const prompt = form.get("prompt");
            const schedule = form.get("schedule");
            if (
              typeof name === "string" &&
              typeof prompt === "string" &&
              typeof schedule === "string"
            )
              void actions.createJob({ name, prompt, schedule }).then(() => setCreating(false));
          }}
        >
          <div>
            <label htmlFor="automation-name">名称</label>
            <input
              id="automation-name"
              name="name"
              required
              autoComplete="off"
              placeholder="例如：每周依赖检查…"
            />
          </div>
          <div>
            <label htmlFor="automation-schedule">计划</label>
            <input
              id="automation-schedule"
              name="schedule"
              required
              autoComplete="off"
              placeholder="例如：0 9 * * 1…"
            />
          </div>
          <div className="automation-form__prompt">
            <label htmlFor="automation-prompt">任务说明</label>
            <textarea
              id="automation-prompt"
              name="prompt"
              required
              autoComplete="off"
              rows={3}
              placeholder="告诉 Pico 每次需要完成什么…"
            />
          </div>
          <div className="button-row">
            <Button onClick={() => setCreating(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={Boolean(busy)}>
              创建
            </Button>
          </div>
        </form>
      )}
      {data.notices.jobs && <InlineNotice tone="warning">{data.notices.jobs}</InlineNotice>}
      {data.jobs.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="还没有定时任务"
          detail="创建后，任务会在这里显示计划、开关和最近状态。"
        />
      ) : (
        <div className="automation-grid">
          {data.jobs.map((job) => (
            <article className="automation-card" key={job.id}>
              <header>
                <span className="automation-card__icon">
                  <Clock3 aria-hidden="true" />
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    disabled={busy === "toggle-job"}
                    onChange={(event) => void actions.toggleJob(job.id, event.target.checked)}
                  />
                  <span />
                </label>
              </header>
              <h3>{job.name}</h3>
              <p>{job.prompt}</p>
              <div className="automation-card__meta">
                <span>{job.schedule}</span>
                <StatusPill status={job.status} />
              </div>
              <footer>
                <time>更新于 {formatRelative(job.updatedAt)}</time>
                <div className="button-row">
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy) || !job.enabled}
                    onClick={() => void actions.runJob(job.id)}
                  >
                    立即运行
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (window.confirm(`删除自动化“${job.name}”？此操作无法撤销。`))
                        void actions.deleteJob(job.id);
                    }}
                  >
                    删除
                  </Button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
