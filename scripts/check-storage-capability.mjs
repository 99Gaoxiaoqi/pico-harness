import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { assertLocalFileStorageCapabilitiesSync } from "../src/storage/local-file-storage.ts";

const SUPPORTED_NODE_RELEASES = new Map([
  [22, 13],
  [24, 3],
  [26, 0],
]);
const SUPPORTED_NODE_LABEL = "Node 22.13+、24.3+ 或 26.x";
const runtime = [
  `Node ${process.version}`,
  `ABI ${process.versions.modules}`,
  `${process.platform}/${process.arch}`,
].join(", ");
const picoHome = resolve(process.env.PICO_HOME?.trim() || join(homedir(), ".pico"));

function fail(summary, error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[storage-check] ${summary}`);
  console.error(`[storage-check] 当前运行时: ${runtime}`);
  if (detail) console.error(`[storage-check] 详情: ${detail}`);
  console.error(
    `[storage-check] 请使用 ${SUPPORTED_NODE_LABEL}，并将 PICO_HOME 放在支持原子 mkdir/rename 与 fsync 的本地文件系统。`,
  );
  process.exitCode = 1;
}

const [nodeMajor = Number.NaN, nodeMinor = Number.NaN] = process.versions.node
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const minimumMinor = SUPPORTED_NODE_RELEASES.get(nodeMajor);
if (minimumMinor === undefined || nodeMinor < minimumMinor) {
  fail(`项目支持 ${SUPPORTED_NODE_LABEL}，检测到 ${process.version}。`, "Node 版本不受支持");
} else {
  try {
    assertLocalFileStorageCapabilitiesSync(picoHome);
    console.log(
      `[storage-check] 通过: ${runtime}, ${picoHome}, atomic mkdir/rename, file+directory fsync, crash recovery`,
    );
  } catch (error) {
    fail("项目所需的本地文件存储能力不可用。", error);
  }
}
