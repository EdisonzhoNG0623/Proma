/**
 * Hermes 会话最近发送的附件图片缓存（key = 用户消息文本）。
 * Hermes 远端历史只存纯文本（无图片），Proma 发送时把图片 data URL 暂存，
 * 历史/持久化 user 消息按文本匹配补图，实现聊天式图片持续显示。
 */
export const hermesSentImageCache = new Map<string, string[]>()
