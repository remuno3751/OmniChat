import type { FastifyInstance } from "fastify";
import { registerApprovalRuleRoutes } from "./approval-rules.js";
import { registerNotifyRoutes } from "./notify.js";
import { registerTemplateRoutes } from "./templates.js";
import { registerPetRoutes } from "./pets.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerCodeRoutes } from "./code.js";

/** PROTOCOL-v4.md routes (one register function per feature file). */
export function registerV4Routes(app: FastifyInstance): void {
  registerApprovalRuleRoutes(app);
  registerNotifyRoutes(app);
  registerTemplateRoutes(app);
  registerPetRoutes(app);
  registerDiagnosticsRoutes(app);
  registerCodeRoutes(app);
}
