import type { steps } from "@workspace/db";

type Step = Pick<typeof steps.$inferSelect, "commitHash" | "content" | "stepIndex">;

export function checkpointFromStep(step: Step) {
  const content = step.content;
  if (
    step.commitHash &&
    typeof content === "object" &&
    content !== null &&
    "bundleKey" in content &&
    typeof content.bundleKey === "string"
  ) {
    return { commitHash: step.commitHash, bundleKey: content.bundleKey };
  }
  return null;
}

export function checkpointAtStep(allSteps: readonly Step[], selectedIndex: number) {
  const selected = allSteps.find((step) => step.stepIndex === selectedIndex);
  if (!selected) throw new Error("The selected fork step does not exist.");
  return [...allSteps]
    .filter((step) => step.stepIndex <= selectedIndex)
    .sort((a, b) => b.stepIndex - a.stepIndex)
    .map(checkpointFromStep)
    .find(Boolean) ?? null;
}