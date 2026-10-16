/** Test-only seed shared by browser regression and the final desktop acceptance harness. */
export const memoryLearningV3Fixture = String.raw`
const source={sessionId:'session',runId:'run',turnId:'turn',eventId:'source'};
const method={kind:'task-lesson',candidateId:'method',itemId:'method-memory',workspaceKey:'/project',workDir:'/project',sessionId:'session',runId:'run',taskId:'task',taskVersion:1,contentVersion:1,recordRevision:1,goal:'先缩小调查范围',content:'先按已知线索缩小范围，再检查相关结果。',representation:'method',usagePolicy:'suggestion',matchHints:['调查线索'],requiredConditions:[],review:'unneeded',risk:'low',maturity:'trial',positiveReuseCount:1,promotionReason:'none',validation:'unknown',enabled:true,lifecycleState:'active',state:'saved',sources:[source],applicability:{taskFamily:'general',toolNames:[],conditions:['仅对当前线索对应的问题使用；证据不足时保留未知。']},createdAt:1,updatedAt:1,evidenceSummary:{deliveredCount:2,independentTaskCount:2,adoptedCount:1,helpfulCount:0,contradictionCount:0,results:[{validation:'pass',scope:'command',count:1}]}};
const taskCase={...method,candidateId:'case',itemId:undefined,goal:'一次偶然恢复',content:'重试后恢复了，但目前不知道恢复原因。',representation:'case',usagePolicy:'case_only',enabled:false,state:'ready',evidenceSummary:undefined};
const decision={...method,candidateId:'decision',itemId:undefined,goal:'发布策略变化',content:'检查指定产物后执行外部发布。',usagePolicy:'review_required',decisionKind:'high_impact',review:'pending',enabled:false,risk:'high',state:'ready',reviewReason:'将每次显式发布改为默认发布；范围仅限当前项目的指定产物。'};
const blocked={...method,candidateId:'blocked',goal:'已被纠正的旧建议',usagePolicy:'blocked',reason:'user_correction',enabled:false,maturity:'suspended'};
const receipt={operationId:'receipt-1',sessionId:'session',committedAt:Date.now(),createdItemCount:2};
const use={useId:'use-1',workspaceKey:'/project',itemId:'method-memory',itemVersion:1,contentHash:'hash',source:{kind:'reviewed-reference',candidateId:'method',contentVersion:1},taskId:'reuse-task',taskVersion:1,sessionId:'session',runId:'reuse-run',referenceHash:'reference',referenceContent:method.content,delivery:'carried',historical:false,adoption:'unknown',validation:'unknown',validationScope:'unknown',excluded:false,deleted:false,sources:[source],managementRevision:1,settingsVersion:1,deletionRevision:0,createdAt:1,updatedAt:1};
`;

/**
 * Final desktop acceptance: seed these records in a disposable workspace through the real Store.
 * Open saved → method, case; open tab=pending → decision; compare each click with its action receipt.
 * Exercise revise, accept/edit_accept, keep_case, defer, delete, useId helpful/correct, archive/restore.
 * While editing, update the same candidate from a second client and switch A→B→A to verify draft CAS.
 * These test seeds demonstrate interface behavior only; they are not evidence of natural model learning.
 */
export const memoryLearningV3AcceptanceSteps = [
  "普通建议无需审批；因果不明案例无审批按钮且不显示晋级次数。",
  "需你决定展示具体变化、范围、影响与来源；忽略不提交，稍后决定保留请求，保留案例不删除。",
  "普通修订发送 revise；明确批准才发送 accept 或 edit_accept。",
  "使用记录 helpful 和 correct 绑定 useId 与引用内容版本；纠正旧版本无普通恢复入口。",
  "事实保存摘要只读已提交 receipt，跨 Run 使用本会话最近保存且按 operationId 去重。",
  "双击一次提交；CAS 保草稿；工作区 A→B→A 后迟到请求不能覆盖当前内容。",
] as const;
