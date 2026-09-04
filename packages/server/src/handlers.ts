import { Layer } from "effect"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { SkillCloudHandler } from "./handlers/skill-cloud"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { PtyHandler } from "./handlers/pty"
import { QuestionHandler } from "./handlers/question"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { DeployKeyHandler } from "./handlers/deploy-key"
import { ProjectCopyHandler } from "./handlers/project-copy"

export const handlers = Layer.mergeAll(
  HealthHandler,
  DeployKeyHandler,
  LocationHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  CredentialHandler,
  PermissionHandler,
  CommandHandler,
  SkillHandler,
  SkillCloudHandler,
  EventHandler,
  PtyHandler,
  QuestionHandler,
  ReferenceHandler,
  ProjectCopyHandler,
)
