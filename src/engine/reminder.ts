/** Compatibility adapter: Runtime owns the policy, Engine preserves its logger wiring. */
import { ReminderInjector as RuntimeReminderInjector } from "@pico/runtime/reminder";
import { logger } from "../observability/logger.js";

export {
  ToolGuardrailController,
  type GuardrailDecision,
  type GuardrailOptions,
  type RuntimeReminderLogger,
} from "@pico/runtime/reminder";

/** @deprecated Reminder 策略已移至 @pico/runtime。 */
export class ReminderInjector extends RuntimeReminderInjector {
  constructor() {
    super(logger);
  }
}
