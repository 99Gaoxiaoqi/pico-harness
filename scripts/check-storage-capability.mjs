import process from "node:process";

/**
 * 票 09(ADR 24 决策 3):文件存储能力探针(原子 mkdir/rename、fsync、
 * commit.json 崩溃恢复)随 JSONL 纪元退役——SQLite 纪元的持久性由
 * pico.sqlite 的 WAL + synchronous=FULL 保证。保留的检查只有 Node 版本
 * 策略:node:sqlite 的模块级 API(backup 等)要求 22.19+/24.3+/26.x。
 */

const SUPPORTED_NODE_RELEASES = new Map([
  [22, 19],
  [24, 3],
  [26, 0],
]);
const SUPPORTED_NODE_LABEL = "Node 22.19+、24.3+ 或 26.x";
const runtime = [
  `Node ${process.version}`,
  `ABI ${process.versions.modules}`,
  `${process.platform}/${process.arch}`,
].join(", ");

const [nodeMajor = Number.NaN, nodeMinor = Number.NaN] = process.versions.node
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const minimumMinor = SUPPORTED_NODE_RELEASES.get(nodeMajor);
if (minimumMinor === undefined || nodeMinor < minimumMinor) {
  console.error(`[storage-check] 项目支持 ${SUPPORTED_NODE_LABEL}，检测到 ${process.version}。`);
  console.error(`[storage-check] 当前运行时: ${runtime}`);
  console.error(`[storage-check] 请使用 ${SUPPORTED_NODE_LABEL}（node:sqlite 需要 22.19+）。`);
  process.exitCode = 1;
} else {
  console.log(`[storage-check] 通过: ${runtime}（Node 版本策略满足 node:sqlite 要求）`);
}
