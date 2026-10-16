import type {
  TaskExperienceCandidate,
  TaskExperienceRequiredCondition,
  TaskExperienceSummary,
} from "@pico/core";

export function experienceSummary(candidate: TaskExperienceCandidate): TaskExperienceSummary {
  const {
    candidateId,
    contentVersion,
    recordRevision,
    review,
    validation,
    enabled,
    applicability,
  } = candidate;
  return {
    candidateId,
    contentVersion,
    recordRevision,
    review,
    validation,
    enabled,
    applicability,
    ...(candidate.representation ? { representation: candidate.representation } : {}),
    ...(candidate.usagePolicy ? { usagePolicy: candidate.usagePolicy } : {}),
    ...(candidate.matchHints ? { matchHints: candidate.matchHints } : {}),
    ...(candidate.requiredConditions ? { requiredConditions: candidate.requiredConditions } : {}),
    ...(candidate.scopeUnresolved ? { scopeUnresolved: true } : {}),
    ...(candidate.decisionKind ? { decisionKind: candidate.decisionKind } : {}),
    ...(candidate.expiresAt !== undefined ? { expiresAt: candidate.expiresAt } : {}),
    ...(candidate.maturity ? { maturity: candidate.maturity } : {}),
    ...(candidate.risk ? { risk: candidate.risk } : {}),
    ...(candidate.promotionReason ? { promotionReason: candidate.promotionReason } : {}),
    ...(candidate.positiveReuseCount !== undefined
      ? { positiveReuseCount: candidate.positiveReuseCount }
      : {}),
    ...(candidate.reviewReason ? { reviewReason: candidate.reviewReason } : {}),
  };
}
export function experienceLocked(candidate: TaskExperienceCandidate): boolean {
  return (
    candidate.reason === "user_correction" ||
    candidate.reason === "trusted_reuse_contradiction" ||
    candidate.validation === "fail" ||
    candidate.validation === "stale"
  );
}
export function experienceUsable(candidate: TaskExperienceCandidate, now: number): boolean {
  return (
    candidate.representation === "method" &&
    candidate.usagePolicy === "suggestion" &&
    candidate.enabled &&
    candidate.lifecycleState === "active" &&
    candidate.state === "saved" &&
    !candidate.scopeUnresolved &&
    !experienceLocked(candidate) &&
    (candidate.expiresAt === undefined || candidate.expiresAt > now)
  );
}
export function experienceHints(
  hints: readonly string[] | undefined,
  content = "",
): readonly string[] {
  const generic =
    /^(?:(?:task|code|file|test|tool|run|任务|代码|文件|测试|工具|方法|经验|检查|结果)[\s、,，-]*)+$/iu;
  const values = hints ?? content.match(/[A-Za-z][\w./-]{2,}|[\p{Script=Han}]{2,10}/gu) ?? [];
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length >= 2 && value.length <= 80 && !generic.test(value)),
    ),
  ].slice(0, 8);
}
export function experienceConditions(
  candidate: Pick<TaskExperienceCandidate, "nativeEvidence" | "applicability">,
  requested?: readonly TaskExperienceRequiredCondition[],
  legacy = false,
): { requiredConditions: readonly TaskExperienceRequiredCondition[]; scopeUnresolved: boolean } {
  const conditions: TaskExperienceRequiredCondition[] = [];
  if (candidate.nativeEvidence)
    conditions.push({ kind: "native-scope", ...candidate.nativeEvidence });
  if (candidate.applicability.spreadsheet)
    conditions.push({ kind: "spreadsheet-range", ...candidate.applicability.spreadsheet });
  if (requested)
    for (const condition of requested) {
      if (!conditions.some((value) => sameExperienceCondition(value, condition)))
        throw new Error("Task experience condition is not observed");
    }
  const spreadsheetWords =
    /^(?:sum|求和|无表头|有限数值|finite[- ]numbers|header[:= ]false|spreadsheet|range|范围|表格|纯数字|数值区域|所有输入均为有限数值|数据区域不含表头|当前纯数值范围|当前数值范围|数值范围没有表头|当前选择区域是有限数值)$/iu;
  const nativeWords = /^(?:native[- ]scope|冻结操作范围|当前冻结范围)$/iu;
  const unknownLegacy =
    legacy &&
    candidate.applicability.conditions.some(
      (value) =>
        !(candidate.applicability.spreadsheet && spreadsheetWords.test(value.trim())) &&
        !(candidate.nativeEvidence && nativeWords.test(value.trim())),
    );
  return { requiredConditions: conditions, scopeUnresolved: !!unknownLegacy };
}
export function experienceContentRisk(content: string): "low" | "high" | "blocked" {
  // Remove only a directly negated action, never the rest of a sentence.
  const proposal = content.replace(
    /(?:不要|避免|不得|不应|禁止|不允许|切勿)\s*(?:绕过(?:审批|权限|确认)|删除|清空|销毁|发布|部署|外部发送|转账|付款)|(?:do not|never|avoid)\s+(?:bypass\s+(?:approval|permission|confirmation)|delete|remove|erase|publish|release|deploy|send|transfer|pay)\b/giu,
    "",
  );
  if (
    /(?:绕过|跳过|无需|不需|bypass|skip)[\s\S]{0,24}(?:审批|权限|确认|凭据|approval|permission|confirmation|credential)|(?:never|do not)\s+(?:ask|request|require)[\s\S]{0,20}(?:approval|permission|confirmation)|(?:不要|无需|不必)(?:询问|请求|要求|等待)[\s\S]{0,12}(?:审批|权限|确认)/iu.test(
      proposal,
    )
  )
    return "blocked";
  return /(?:\bdelete\b|\bremove\b|\berase\b|\brm\s+-rf\b|\bdrop\s+(?:table|database)\b|删除|清空|销毁|\bpublish\b|\brelease\b|\bdeploy\b|发布|部署|外部发送|\bsend\s+(?:an?\s+)?(?:email|message|request)|发送|邮件|转账|付款|\btransfer\b|\bpayment\b|\bsudo\b|\bchmod\b|更改权限|修改权限)/iu.test(
    proposal,
  )
    ? "high"
    : "low";
}

function sameExperienceCondition(
  left: TaskExperienceRequiredCondition,
  right: TaskExperienceRequiredCondition,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "native-scope" && right.kind === "native-scope")
    return (
      left.candidateId === right.candidateId &&
      left.claimRevision === right.claimRevision &&
      left.claimHash === right.claimHash &&
      left.scopeHash === right.scopeHash
    );
  return (
    left.kind === "spreadsheet-range" &&
    right.kind === "spreadsheet-range" &&
    left.operation === right.operation &&
    left.header === right.header &&
    left.dataKind === right.dataKind
  );
}
