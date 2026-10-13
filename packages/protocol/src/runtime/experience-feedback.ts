import type { ExperienceUse, ExperienceEffect, ExperienceDiagnostic } from '@pico/core';
import type { WorkspaceParams } from './base.js';
import { isJsonObject } from './base.js';
import { invalidParams, invalidResult } from './errors.js';
import { exactParamShape, exactResultShape, boundedNonEmptyStringParam, positiveIntegerParam, resultArray, resultBoolean, resultNonNegativeInteger, resultOneOf, resultString, stringParam, oneOfParam } from './validation.js';
import type { RuntimeResultRule } from './validation.js';
import { experienceSourceResult } from './task-experience.js';
const sourceResult: RuntimeResultRule = (v,p) => {
  if (!isJsonObject(v)) throw invalidResult(`${p} 不是经验来源`);
  const common={candidateId:resultString};
  if(v.kind==='reviewed-reference') exactResultShape({...common,kind:resultOneOf(['reviewed-reference']),contentVersion:resultNonNegativeInteger})(v,p);
  else if(v.kind==='execution-validated') exactResultShape({...common,kind:resultOneOf(['execution-validated']),claimRevision:resultNonNegativeInteger,claimHash:resultString,scopeHash:resultString})(v,p);
  else if(v.kind==='execution-evidence') exactResultShape({...common,kind:resultOneOf(['execution-evidence']),candidateVersion:resultNonNegativeInteger,contentHash:resultString})(v,p);
  else throw invalidResult(`${p} 经验来源不受支持`);
};
const adoption=resultOneOf(['unknown','observed','not_applied']);
const validation=resultOneOf(['unknown','pass','fail','stale']);
const validationScope=resultOneOf(['unknown','native-claim','spreadsheet-range','command']);
export const experienceUseResult = exactResultShape({
 useId:resultString,workspaceKey:resultString,source:sourceResult,itemId:resultString,itemVersion:resultNonNegativeInteger,contentHash:resultString,
 taskId:resultString,taskVersion:resultNonNegativeInteger,sessionId:resultString,runId:resultString,referenceHash:resultString,
 delivery:resultOneOf(['pending','carried','unknown']),historical:resultBoolean,managementRevision:resultNonNegativeInteger,settingsVersion:resultNonNegativeInteger,deletionRevision:resultNonNegativeInteger,
 adoption,validation,validationScope,excluded:resultBoolean,deleted:resultBoolean,sources:resultArray(experienceSourceResult),createdAt:resultNonNegativeInteger,updatedAt:resultNonNegativeInteger,
},{hostRunId:resultString,referenceContent:resultString,recallEventId:resultString,recallSequence:resultNonNegativeInteger,deliverySequence:resultNonNegativeInteger,providerCallId:resultString,physicalAttemptId:resultString});
export const experienceEffectResult=exactResultShape({effectId:resultString,useId:resultString,preparedEventId:resultString,outcomeEventId:resultString,preparedSequence:resultNonNegativeInteger,outcomeSequence:resultNonNegativeInteger,adoption,validation,validationScope,reason:resultString,sources:resultArray(experienceSourceResult),trustedContradiction:resultBoolean,createdAt:resultNonNegativeInteger});
const diagnosticResult=exactResultShape({diagnosticId:resultString,workspaceKey:resultString,sessionId:resultString,runId:resultString,phase:resultOneOf(['identity','proposal','reference','effect','worker']),reason:resultString,createdAt:resultNonNegativeInteger});
export type ExperienceFeedbackMethodMap = {
 readonly 'memory.experience.query': {readonly params:WorkspaceParams & {readonly sessionId?:string;readonly itemId?:string;readonly cursor?:string;readonly limit?:number};readonly result:{readonly experienceVersion:1;readonly uses:readonly ExperienceUse[];readonly diagnostics:readonly ExperienceDiagnostic[];readonly nextCursor?:string}};
 readonly 'memory.experience.detail': {readonly params:WorkspaceParams & {readonly useId:string};readonly result:{readonly experienceVersion:1;readonly use:ExperienceUse;readonly effects:readonly ExperienceEffect[]}};
 readonly 'memory.experience.feedback': {readonly params:WorkspaceParams & {readonly useId:string;readonly expectedItemVersion:number;readonly operationId:string;readonly action:'not_applicable'|'disable'};readonly result:{readonly experienceVersion:1;readonly use:ExperienceUse}};
};
export const experienceFeedbackParamValidators={
 'memory.experience.query':exactParamShape({workspacePath:stringParam},{sessionId:boundedNonEmptyStringParam(512),itemId:boundedNonEmptyStringParam(512),cursor:boundedNonEmptyStringParam(4096),limit:(v,p)=>{positiveIntegerParam(v,p);if((v as number)>100)throw invalidParams(`${p} 不得超过100`);}}),
 'memory.experience.detail':exactParamShape({workspacePath:stringParam,useId:boundedNonEmptyStringParam(1024)}),
 'memory.experience.feedback':exactParamShape({workspacePath:stringParam,useId:boundedNonEmptyStringParam(1024),expectedItemVersion:positiveIntegerParam,operationId:boundedNonEmptyStringParam(512),action:oneOfParam(['not_applicable','disable'])}),
};
export const experienceFeedbackResultValidators={
 'memory.experience.query':exactResultShape({experienceVersion:resultOneOf([1]),uses:resultArray(experienceUseResult),diagnostics:resultArray(diagnosticResult)},{nextCursor:resultString}),
 'memory.experience.detail':exactResultShape({experienceVersion:resultOneOf([1]),use:experienceUseResult,effects:resultArray(experienceEffectResult)}),
 'memory.experience.feedback':exactResultShape({experienceVersion:resultOneOf([1]),use:experienceUseResult}),
};
