/**
 * 斜杠命令：输入 `/` 呼出菜单即可触发电脑操作。
 *
 * 设计说明：dsh 的命令处理器是宿主侧执行器（结果只有文本通道，不发给模型），
 * 因此这里的命令不直接动手，而是把构造好的任务指令投给当前 agent（followup），
 * 由模型调用 computer_* / browser_* 工具执行——截图、点击、报错都能像普通对话
 * 一样完整展示，也复用既有的权限与审批链路。
 *
 * @module dsh-computer-use/commands
 */
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

/** 单条命令定义：把原始输入翻译成给模型的执行指令。 */
interface SlashCommand {
  name: string
  description: string
  /** 参数输入提示（显示在 / 菜单里）；无参数的命令省略。 */
  hint?: string
  /** 由 rawInput 生成投给模型的指令文本。 */
  instruction: (rawInput: string) => string
}

const COMMANDS: readonly SlashCommand[] = [
  {
    name: 'shot',
    description: '截屏查看当前屏幕',
    instruction: () =>
      '立即调用 computer_screenshot（带 marks）截一张当前屏幕的图并展示出来，再用一两句话概括屏幕上的主要内容。',
  },
  {
    name: 'windows',
    description: '列出当前打开的窗口',
    instruction: () =>
      '调用 computer_windows 列出当前所有可见窗口，用表格报给我每个窗口的标题与进程名。',
  },
  {
    name: 'click',
    description: '按屏幕上的文字点击',
    hint: '<要点的文字>',
    instruction: (raw) =>
      `在屏幕上找到文字「${raw}」并点击它（优先 computer_click -findText），完成后截图核对并汇报是否成功。`,
  },
  {
    name: 'type',
    description: '输入一段文字',
    hint: '<要输入的文字>',
    instruction: (raw) =>
      `用 computer_type 输入以下文字（保持原文，不要增删）：${raw}。输完读回核对。`,
  },
  {
    name: 'browse',
    description: '用专用浏览器打开网址',
    hint: '<网址>',
    instruction: (raw) =>
      `用 browser_open 打开 ${raw}，等页面加载完读一下主要内容并概括给我。`,
  },
]

/** 注册全部斜杠命令；返回一次性注册（随插件生命周期释放）。 */
export function registerSlashCommands(ctx: Context): void {
  ctx.effect(() => {
    const disposers = COMMANDS.map((command) =>
      ctx.commands.register({
        definitionId: CommandDefinitionId(`@dsh-external/dsh-computer-use/${command.name}`),
        name: command.name,
        description: command.description,
        ...(command.hint === undefined ? {} : { input: { hint: command.hint } }),
        handler: (invocation: CommandInvocation) => {
          const text = command.instruction(invocation.rawInput.trim())
          invocation.agent.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' as const },
          }))
          return { kind: 'success' as const }
        },
      }),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
