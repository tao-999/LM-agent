export function stripPrivateModelOutput(value: string): string {
  return value
    .replace(
      /<details\b[^>]*>\s*<summary\b[^>]*>\s*本次会话结构统计（仅调试用）\s*<\/summary>[\s\S]*?<\/details\s*>/giu,
      ''
    )
    .replace(
      /(?:不好意思，好像出错了。希望以下内容对你有帮助|任务类型判断错误，导致工具调用不符合预期|##\s*工作流提示)[\s\S]*$/giu,
      ''
    )
}
