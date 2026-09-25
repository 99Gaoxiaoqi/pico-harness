export interface ObservedElement {
  readonly index: number;
  readonly role: string;
  readonly title: string;
  readonly description: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ComputerObservation {
  readonly id: string;
  readonly at: number;
  readonly pid: number;
  readonly elements: readonly ObservedElement[];
}

export function resolveObservedElement(input: {
  readonly previous: ComputerObservation | undefined;
  readonly observationId: string;
  readonly elementIndex: number;
  readonly currentPid: number;
  readonly currentElements: readonly ObservedElement[];
  readonly now: number;
}): ObservedElement {
  const { previous } = input;
  if (!previous || previous.id !== input.observationId || input.now - previous.at > 30_000) {
    throw new Error("观察已过期，请重新执行 computer_observe");
  }
  if (input.currentPid !== previous.pid) throw new Error("前台应用已切换，请重新观察");
  const old = previous.elements.find((element) => element.index === input.elementIndex);
  const fresh = input.currentElements.find((element) => element.index === input.elementIndex);
  if (!old || !fresh || !sameElement(old, fresh)) {
    throw new Error("目标元素已变化，请重新观察");
  }
  return fresh;
}

function sameElement(left: ObservedElement, right: ObservedElement): boolean {
  return (
    left.role === right.role &&
    left.title === right.title &&
    left.description === right.description &&
    Math.abs(left.x - right.x) <= 2 &&
    Math.abs(left.y - right.y) <= 2 &&
    Math.abs(left.width - right.width) <= 2 &&
    Math.abs(left.height - right.height) <= 2
  );
}
