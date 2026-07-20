import { redactSensitiveText } from "../mcp/redact.js";
import type {
  MemoryProposalSanitization,
  RawMemoryProposalCandidate,
} from "./proposal-contracts.js";

const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;
const KNOWN_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u;
const HIGH_ENTROPY_TOKEN_RE = /\b[A-Za-z0-9_+/=-]{28,}\b/gu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const CN_PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const INTERNATIONAL_PHONE_RE = /(?<!\w)\+\d(?:[\d -]{8,16}\d)(?!\w)/gu;
const CN_ID_RE = /(?<!\d)\d{17}[\dX](?!\d)/giu;
const CARD_CANDIDATE_RE = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu;

const INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)\b/iu,
  /\b(?:reveal|show|leak|print)\b.{0,30}\b(?:system\s+prompt|developer\s+message|hidden\s+instructions?)\b/iu,
  /\b(?:bypass|disable|override)\b.{0,24}\b(?:safety|guardrails?|policy)\b/iu,
  /\b(?:call|invoke|execute|run)\b.{0,20}\b(?:tool|command|shell)\b/iu,
  /忽略.{0,20}(?:之前|上面|所有).{0,20}(?:指令|规则|提示)/iu,
  /(?:泄露|显示|输出).{0,24}(?:系统提示|开发者消息|隐藏指令)/iu,
  /(?:绕过|关闭|覆盖).{0,20}(?:安全|防护|策略)/iu,
  /(?:调用|执行|运行).{0,16}(?:工具|命令|脚本)/iu,
] as const;

export function sanitizeMemoryProposalCandidate(
  candidate: RawMemoryProposalCandidate,
): MemoryProposalSanitization {
  const title = normalizeStoredText(candidate.title);
  const content = normalizeStoredText(candidate.content);
  const reason = normalizeStoredText(candidate.reason);
  const combined = `${title}\n${content}\n${reason}`;
  const rejectCodes = secretCodes(combined);
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(combined))) {
    rejectCodes.push("prompt_injection");
  }
  if (rejectCodes.length > 0) {
    return { disposition: "reject", safetyCodes: [...new Set(rejectCodes)] };
  }

  const piiCodes: string[] = [];
  const sanitizePii = (value: string): string =>
    value
      .replace(EMAIL_RE, () => markPii(piiCodes, "pii_email", "[REDACTED_EMAIL]"))
      .replace(CN_PHONE_RE, () => markPii(piiCodes, "pii_phone", "[REDACTED_PHONE]"))
      .replace(INTERNATIONAL_PHONE_RE, () => markPii(piiCodes, "pii_phone", "[REDACTED_PHONE]"))
      .replace(CN_ID_RE, () => markPii(piiCodes, "pii_government_id", "[REDACTED_ID]"))
      .replace(CARD_CANDIDATE_RE, (match) =>
        isLuhnValid(match) ? markPii(piiCodes, "pii_payment_card", "[REDACTED_CARD]") : match,
      );
  const safeTitle = sanitizePii(title);
  const safeContent = sanitizePii(content);
  const safeReason = sanitizePii(reason);
  return {
    ...candidate,
    title: safeTitle,
    content: safeContent,
    reason: safeReason,
    disposition: piiCodes.length > 0 ? "quarantine" : "allow",
    safetyCodes: [...new Set(piiCodes)],
  };
}

export function normalizeMemoryIdentityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[\s\u00a0]+/gu, " ")
    .replace(/[.!！?？。,，;；:：]+$/gu, "")
    .trim();
}

function normalizeStoredText(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll(/[\s\u00a0]+/gu, " ")
    .trim();
}

function secretCodes(value: string): string[] {
  const codes: string[] = [];
  if (PRIVATE_KEY_RE.test(value)) codes.push("secret_private_key");
  if (JWT_RE.test(value)) codes.push("secret_jwt");
  if (KNOWN_TOKEN_RE.test(value)) codes.push("secret_known_token");
  if (redactSensitiveText(value) !== value) codes.push("secret_labeled_value");
  for (const match of value.matchAll(HIGH_ENTROPY_TOKEN_RE)) {
    if (looksHighEntropy(match[0])) {
      codes.push("secret_high_entropy");
      break;
    }
  }
  return codes;
}

function looksHighEntropy(token: string): boolean {
  if (/^\d+$/u.test(token) || /^[a-f\d-]+$/iu.test(token)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[_+/=-]/u].filter((pattern) =>
    pattern.test(token),
  ).length;
  return classes >= 3 && shannonEntropy(token) >= 4;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function markPii(codes: string[], code: string, replacement: string): string {
  codes.push(code);
  return replacement;
}

function isLuhnValid(value: string): boolean {
  const digits = value.replaceAll(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
