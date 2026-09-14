const CREATION_SIGNAL =
  /(?:创建|新建|新增|添加|设置|设定|安排|建立|开启|启用|提醒(?:我|我们)?|定时(?:执行|运行|提醒|检查|发送|生成|备份|同步|调用)|create|add|set\s+up|schedule|remind\s+(?:me|us))/iu;
const RECURRENCE_SIGNAL =
  /(?:每(?:隔)?(?:个)?(?:分钟|小时|天|日|周|星期|月|季度|年|工作日)|工作日|每天|每日|每周|每月|每年|每小时|每分钟|daily|weekly|monthly|yearly|hourly|every\s+(?:minute|hour|day|weekday|week|month|quarter|year)|each\s+(?:day|weekday|week|month|quarter|year))/iu;
const CRON_DISCUSSION =
  /(?:(?:解释|介绍|讨论|了解|学习|原理|语法|区别|是什么|如何工作|怎么工作).{0,16}(?:cron|定时任务)|(?:cron|定时任务).{0,16}(?:解释|介绍|讨论|了解|学习|原理|语法|区别|是什么|如何|怎么)|(?:explain|learn|understand|how\s+does).{0,24}(?:cron|scheduled?\s+(?:job|task))|(?:cron|scheduled?\s+(?:job|task)).{0,24}(?:syntax|principle|work|explain))/iu;

/** Lightweight hint only; final schedule validation and persistence remain in the Host coordinator. */
export function looksLikeScheduleCreationIntent(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length === 0 || CRON_DISCUSSION.test(text)) return false;
  return CREATION_SIGNAL.test(text) && RECURRENCE_SIGNAL.test(text);
}
