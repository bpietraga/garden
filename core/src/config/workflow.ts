/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { isEqual, merge, omit, take } from "lodash"
import { joi, joiUserIdentifier, joiVariableName, joiIdentifier } from "./common"
import { DEFAULT_API_VERSION } from "../constants"
import { deline, dedent } from "../util/string"
import { defaultContainerLimits, ServiceLimitSpec } from "../plugins/container/config"
import { Garden } from "../garden"
import { WorkflowConfigContext } from "./config-context"
import { resolveTemplateStrings } from "../template-string"
import { validateWithPath } from "./validation"
import { ConfigurationError } from "../exceptions"
import { getCoreCommands } from "../commands/commands"
import { CommandGroup } from "../commands/base"
import { EnvironmentConfig, getNamespace } from "./project"
import { globalOptions } from "../cli/params"
import { isTruthy } from "../util/util"
import { parseCliArgs, pickCommand } from "../cli/helpers"

export interface WorkflowConfig {
  apiVersion: string
  description?: string
  name: string
  kind: "Workflow"
  path: string
  configPath?: string
  keepAliveHours?: number
  files?: WorkflowFileSpec[]
  limits?: ServiceLimitSpec
  steps: WorkflowStepSpec[]
  triggers?: TriggerSpec[]
}

export interface WorkflowRunConfig extends Omit<WorkflowConfig, "triggers"> {
  environment: string // The environment the workflow run is executed in
  namespace: string // The namespace the workflow run is executed in
}

export function makeRunConfig(
  workflowConfig: WorkflowConfig,
  environment: string,
  namespace: string
): WorkflowRunConfig {
  return { ...omit(workflowConfig, ["triggers"]), environment, namespace }
}

export interface WorkflowResource extends WorkflowConfig {}

export const workflowConfigSchema = () =>
  joi
    .object()
    .keys({
      apiVersion: joi
        .string()
        .default(DEFAULT_API_VERSION)
        .valid(DEFAULT_API_VERSION)
        .description("The schema version of this workflow's config (currently not used)."),
      kind: joi.string().default("Workflow").valid("Workflow"),
      name: joiUserIdentifier().required().description("The name of this workflow.").example("my-workflow"),
      description: joi.string().description("A description of the workflow."),
      files: joi.array().items(workflowFileSchema()).description(dedent`
          A list of files to write before starting the workflow.

          This is useful to e.g. create files required for provider authentication, and can be created from data stored in secrets or templated strings.

          Note that you cannot reference provider configuration in template strings within this field, since they are resolved after these files are generated. This means you can reference the files specified here in your provider configurations.
          `),
      keepAliveHours: joi
        .number()
        .default(48)
        .description("The number of hours to keep the workflow pod running after completion."),
      limits: joi
        .object()
        .keys({
          cpu: joi
            .number()
            .default(defaultContainerLimits.cpu)
            .min(1000)
            .description("The maximum amount of CPU the workflow pod can use, in millicpus (i.e. 1000 = 1 CPU)"),
          memory: joi
            .number()
            .default(defaultContainerLimits.memory)
            .min(1024)
            .description("The maximum amount of RAM the workflow pod can use, in megabytes (i.e. 1024 = 1 GB)"),
        })
        .default(defaultContainerLimits),
      steps: joi.array().items(workflowStepSchema()).required().min(1).description(deline`
          The steps the workflow should run. At least one step is required. Steps are run sequentially.
          If a step fails, subsequent steps are skipped.
        `),
      triggers: joi
        .array()
        .items(triggerSchema())
        .description(
          `A list of triggers that determine when the workflow should be run, and which environment should be used (Garden Enterprise only).`
        )
        .meta({ enterprise: true }),
    })
    .unknown(true)
    .description("Configure a workflow for this project.")

export interface WorkflowFileSpec {
  path: string
  data?: string
  secretName?: string
}

export const workflowFileSchema = () =>
  joi
    .object()
    .keys({
      path: joi
        .posixPath()
        .relativeOnly()
        .subPathOnly()
        .description(
          dedent`
          POSIX-style path to write the file to, relative to the project root (or absolute). If the path contains one
          or more directories, they are created automatically if necessary.
          If any of those directories conflict with existing file paths, or if the file path conflicts with an existing directory path, an error will be thrown.
          **Any existing file with the same path will be overwritten, so be careful not to accidentally overwrite files unrelated to your workflow.**
          `
        )
        .example(".auth/kubeconfig.yaml"),
      data: joi.string().description("The file data as a string."),
      secretName: joiVariableName()
        .description("The name of a Garden secret to copy the file data from (Garden Enterprise only).")
        .meta({ enterprise: true }),
    })
    .xor("data", "secretName")
    .description(
      "A file to create ahead of running the workflow, within the project root. Must specify one of `data` or `secretName` (but not both)."
    )

export interface WorkflowStepSpec {
  name?: string
  command?: string[]
  description?: string
  script?: string
  skip?: boolean
  when?: workflowStepModifier
}

export const workflowStepSchema = () => {
  const cmdConfigs = getStepCommands()
  const cmdDescriptions = cmdConfigs
    .map((c) => c.getPath().join(", "))
    .sort()
    .map((prefix) => `\`[${prefix}]\``)
    .join("\n")

  return joi
    .object()
    .keys({
      name: joiIdentifier().description(dedent`
        An identifier to assign to this step. If none is specified, this defaults to "step-<number of step>", where
        <number of step> is the sequential number of the step (first step being number 1).

        This identifier is useful when referencing command outputs in following steps. For example, if you set this
        to "my-step", following steps can reference the \${steps.my-step.outputs.*} key in the \`script\` or \`command\`
        fields.
      `),
      command: joi
        .array()
        .items(joi.string())
        .description(
          dedent`
          A Garden command this step should run, followed by any required or optional arguments and flags.
          Arguments and options for the commands may be templated, including references to previous steps, but for now
          the commands themselves (as listed below) must be hard-coded.

          Supported commands:

          ${cmdDescriptions}
          \n
          `
        )
        .example(["run", "task", "my-task"]),
      description: joi.string().description("A description of the workflow step."),
      script: joi.string().description(
        dedent`
        A bash script to run. Note that the host running the workflow must have bash installed and on path.
        It is considered to have run successfully if it returns an exit code of 0. Any other exit code signals an error,
        and the remainder of the workflow is aborted.

        The script may include template strings, including references to previous steps.
        `
      ),
      skip: joi
        .boolean()
        .default(false)
        .description(
          `Set to true to skip this step. Use this with template conditionals to skip steps for certain environments or scenarios.`
        )
        .example("${environment.name != 'prod'}"),
      when: joi.string().allow("onSuccess", "onError", "always", "never").default("onSuccess").description(dedent`
        If used, this step will be run under the following conditions (may use template strings):

        \`onSuccess\` (default): This step will be run if all preceding steps succeeded or were skipped.

        \`onError\`: This step will be run if a preceding step failed, or if its preceding step has \`when: onError\`.
        If the next step has \`when: onError\`, it will also be run. Otherwise, all subsequent steps are ignored.

        \`always\`: This step will always be run, regardless of whether any preceding steps have failed.

        \`never\`: This step will always be ignored.

        See the [workflows guide](https://docs.garden.io/using-garden/workflows#the-skip-and-when-options) for details
        and examples.
        `),
    })
    .xor("command", "script")
    .description("A workflow step. Must specify either `command` or `script` (but not both).")
}

export type workflowStepModifier = "onSuccess" | "onError" | "always" | "never"

export const triggerEvents = [
  "create",
  "push",
  "pull-request",
  "pull-request-created",
  "pull-request-updated",
  "pull-request-opened",
  "pull-request-closed",
  "release",
  "release-published",
  "release-unpublished",
  "release-created",
  "release-edited",
  "release-deleted",
  "release-prereleased",
]

export interface TriggerSpec {
  environment: string
  namespace?: string
  events?: string[]
  branches?: string[]
  tags?: string[]
  ignoreBranches?: string[]
  ignoreTags?: string[]
}

export const triggerSchema = () => {
  const eventDescriptions = triggerEvents
    .sort()
    .map((event) => `\`${event}\``)
    .join(", ")

  return joi.object().keys({
    environment: joi.string().required().description(deline`
        The environment name (from your project configuration) to use for the workflow when matched by this trigger.
      `),
    namespace: joi.string().description(deline`
        The namespace to use for the workflow when matched by this trigger. Follows the namespacing setting used for
        this trigger's environment, as defined in your project's environment configs.
      `),
    events: joi
      .array()
      .items(joi.string().valid(...triggerEvents))
      .unique()
      .description(
        dedent`
        A list of [GitHub events](https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads) that should trigger this workflow.

        Supported events:

        ${eventDescriptions}
        \n
        `
      ),
    branches: joi
      .array()
      .items(joi.string())
      .unique()
      .description("If specified, only run the workflow for branches matching one of these filters."),
    tags: joi
      .array()
      .items(joi.string())
      .unique()
      .description("If specified, only run the workflow for tags matching one of these filters."),
    ignoreBranches: joi
      .array()
      .items(joi.string())
      .unique()
      .description("If specified, do not run the workflow for branches matching one of these filters."),
    ignoreTags: joi
      .array()
      .items(joi.string())
      .unique()
      .description("If specified, do not run the workflow for tags matching one of these filters."),
  })
}

export interface WorkflowConfigMap {
  [key: string]: WorkflowConfig
}

export function resolveWorkflowConfig(garden: Garden, config: WorkflowConfig) {
  const log = garden.log
  const context = new WorkflowConfigContext(garden)
  log.silly(`Resolving template strings for workflow ${config.name}`)
  let resolvedConfig = {
    ...resolveTemplateStrings(omit(config, "name", "triggers"), context, { allowPartial: true }),
    name: config.name,
  }
  if (config.triggers) {
    resolvedConfig["triggers"] = config.triggers
  }
  log.silly(`Validating config for workflow ${config.name}`)

  resolvedConfig = <WorkflowConfig>validateWithPath({
    config: resolvedConfig,
    configType: "workflow",
    schema: workflowConfigSchema(),
    path: config.path,
    projectRoot: garden.projectRoot,
  })

  validateSteps(resolvedConfig)
  validateTriggers(resolvedConfig, garden.environmentConfigs)
  populateNamespaceForTriggers(resolvedConfig, garden.environmentConfigs)

  return resolvedConfig
}

/**
 * Get all commands whitelisted for workflows
 */
function getStepCommands() {
  return getCoreCommands()
    .flatMap((cmd) => {
      if (cmd instanceof CommandGroup) {
        return cmd.getSubCommands()
      } else {
        return [cmd]
      }
    })
    .filter((cmd) => cmd.workflows)
}

const globalOptionNames = Object.keys(globalOptions).sort()

/**
 * Throws if one or more steps refers to a command that is not supported in workflows, or one that uses CLI options
 * that are not supported for step commands.
 */
function validateSteps(config: WorkflowConfig) {
  const prefixErrors = validateStepCommandPrefixes(config)
  const argumentErrors = validateStepCommandOptions(config)
  const errors = [prefixErrors, argumentErrors].filter(isTruthy)
  let errorMsg = errors.map(({ msg }) => msg).join("\n\n")
  let errorDetail = merge({}, ...errors.map(({ detail }) => detail))

  if (errorMsg) {
    throw new ConfigurationError(errorMsg, errorDetail)
  }
}

function validateStepCommandPrefixes(config: WorkflowConfig) {
  const validStepCommandPrefixes = getStepCommands().map((c) => c.getPath())
  const stepsWithInvalidPrefix: WorkflowStepSpec[] = config.steps.filter(
    (step) =>
      !!step.command && !validStepCommandPrefixes.find((valid) => isEqual(valid, take(step.command, valid.length)))
  )

  if (stepsWithInvalidPrefix.length > 0) {
    const cmdString = stepsWithInvalidPrefix.length === 1 ? "command" : "commands"
    const descriptions = stepsWithInvalidPrefix.map((step) => `[${step.command!.join(", ")}]`)
    const validDescriptions = validStepCommandPrefixes.map((cmd) => `[${cmd.join(", ")}]`)
    const msg = dedent`
      Invalid step ${cmdString} for workflow ${config.name}:

      ${descriptions.join("\n")}

      Valid step commands:

      ${validDescriptions.join("\n")}
    `
    return { msg, detail: { stepsWithInvalidPrefix } }
  } else {
    return null
  }
}

/**
 * Finds usages of global CLI options in `step.commandSpec` (if present).
 *
 * These will be ignored when the step command is run, so we warn the user not to use them.
 *
 * TODO: Also detect invalid command args at validation time (these will result in exceptions when the workflow is run).
 */
function findInvalidOptions(step: WorkflowStepSpec) {
  if (!step.command) {
    return null
  }
  const { command, rest } = pickCommand(getStepCommands(), step.command!)
  const parsedArgs = parseCliArgs({ stringArgs: rest, command, cli: false, skipDefault: true })
  const usedGlobalOptions = Object.entries(parsedArgs)
    .filter(([name, value]) => globalOptionNames.find((optName) => optName === name) && !!value)
    .map(([name, _]) => `--${name}`)
  if (usedGlobalOptions.length > 0) {
    const availableOptions = Object.keys(command!.options || {})
    const availableDescription =
      availableOptions.length > 0 ? `(available options: ${availableOptions.map((opt) => `--${opt}`).join(", ")})` : ""
    const errorMsg = dedent`
      Invalid options in step command [${step.command!.join(", ")}]: ${usedGlobalOptions.join(", ")}
      ${availableDescription}
    `
    return { step, errorMsg }
  } else {
    return null
  }
}

function validateStepCommandOptions(config: WorkflowConfig) {
  const invalidSteps = config.steps.map((step) => findInvalidOptions(step)).filter(isTruthy)

  if (invalidSteps.length > 0) {
    const msgPrefix = `Invalid step command options for workflow ${config.name}:`
    const msg = dedent`
      ${msgPrefix}

      ${invalidSteps.map((s) => s.errorMsg).join("\n\n")}

      Global options (such as --env or --log-level) are not available in workflow step commands
    `
    return { msg, detail: { invalidStepCommands: invalidSteps.map((e) => e.step.command) } }
  } else {
    return null
  }
}

/**
 * Throws if one or more triggers uses an environment that isn't defined in the project's config.
 */
function validateTriggers(config: WorkflowConfig, environmentConfigs: EnvironmentConfig[]) {
  const invalidTriggers: TriggerSpec[] = []
  const environmentNames = environmentConfigs.map((c) => c.name)
  for (const trigger of config.triggers || []) {
    if (!environmentNames.includes(trigger.environment)) {
      invalidTriggers.push(trigger)
    }
  }

  if (invalidTriggers.length > 0) {
    const msgPrefix =
      invalidTriggers.length === 1
        ? `Invalid environment in trigger for workflow ${config.name}:`
        : `Invalid environments in triggers for workflow ${config.name}:`

    const msg = dedent`
      ${msgPrefix}

      ${invalidTriggers.map((t) => t.environment).join(", ")}

      Valid environments (defined in your project-level garden.yml):

      ${environmentNames.join(", ")}
    `

    throw new ConfigurationError(msg, { invalidTriggers })
  }
}

export function populateNamespaceForTriggers(config: WorkflowConfig, environmentConfigs: EnvironmentConfig[]) {
  try {
    for (const trigger of config.triggers || []) {
      const environmentConfigForTrigger = environmentConfigs.find((c) => c.name === trigger.environment)
      trigger.namespace = getNamespace(environmentConfigForTrigger!, trigger.namespace)
    }
  } catch (err) {
    throw new ConfigurationError(`Invalid namespace in trigger for workflow ${config.name}: ${err.message}`, { err })
  }
}
