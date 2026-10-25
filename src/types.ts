/**
 * 模块职责：Telegram Bot API 报文的类型（只描述本适配器读到的字段）
 * 依赖方向：叶子模块
 * 生命周期：纯类型
 * 注意事项：字段按 Bot API 文档的"Optional"标注写成可选。平台少给一个字段时解码侧降级，
 *          不抛错。完整定义见 https://core.telegram.org/bots/api#available-types
 */

/** 用户（`User`） */
export interface TgUser {
  /** 用户 id */
  id: number
  /** 是否机器人 */
  is_bot?: boolean
  /** 名 */
  first_name?: string
  /** 姓 */
  last_name?: string
  /** 用户名（不含 @） */
  username?: string
}

/** 会话（`Chat`；`getChat` 返回的 `ChatFullInfo` 是它的超集） */
export interface TgChat {
  /** 会话 id；群与频道为负数 */
  id: number
  /** private / group / supergroup / channel */
  type: string
  /** 群名 */
  title?: string
  /** 公开用户名 */
  username?: string
  /** 私聊对方的名 */
  first_name?: string
  /** 私聊对方的姓 */
  last_name?: string
  /** 是否开启了话题（forum） */
  is_forum?: boolean
  /** 头像（仅 getChat） */
  photo?: { big_file_id?: string }
  /** 群的默认权限（仅 getChat） */
  permissions?: TgChatPermissions
}

/** 消息实体（`MessageEntity`）；offset / length 以 UTF-16 码元计 */
export interface TgEntity {
  /** 类型：mention / text_mention / bot_command / bold / text_link … */
  type: string
  /** 起点 */
  offset: number
  /** 长度 */
  length: number
  /** text_link 的地址 */
  url?: string
  /** text_mention 指向的用户 */
  user?: TgUser
}

/** 图片的一个尺寸（`PhotoSize`） */
export interface TgPhotoSize {
  /** 文件 id，可直接用于再次发送 */
  file_id: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
  /** 字节数 */
  file_size?: number
}

/** 通用文件字段（Document / Audio / Voice / Video / Animation / Sticker 共有的部分） */
export interface TgFile {
  /** 文件 id */
  file_id: string
  /** 文件名 */
  file_name?: string
  /** MIME */
  mime_type?: string
  /** 字节数 */
  file_size?: number
  /** 时长（秒） */
  duration?: number
  /** 宽 */
  width?: number
  /** 高 */
  height?: number
}

/** 贴纸 */
export interface TgSticker extends TgFile {
  /** 关联的 emoji */
  emoji?: string
  /** 是否 TGS 动画贴纸 */
  is_animated?: boolean
  /** 是否 WEBM 视频贴纸 */
  is_video?: boolean
}

/** 消息（`Message`） */
export interface TgMessage {
  /** 会话内消息 id */
  message_id: number
  /** 话题 id */
  message_thread_id?: number
  /** 是否发在话题里 */
  is_topic_message?: boolean
  /** 发送者；频道消息与匿名管理员时缺省或为占位机器人 */
  from?: TgUser
  /** 以某个会话的身份发送（匿名管理员、关联频道） */
  sender_chat?: TgChat
  /** 秒级时间戳；`InaccessibleMessage` 为 0 */
  date: number
  /** 所在会话 */
  chat: TgChat
  /** 被回复的消息 */
  reply_to_message?: TgMessage
  /** 文字 */
  text?: string
  /** 文字的实体 */
  entities?: TgEntity[]
  /** 媒体说明文字 */
  caption?: string
  /** 说明文字的实体 */
  caption_entities?: TgEntity[]
  /** 图片（多个尺寸，升序） */
  photo?: TgPhotoSize[]
  /** 文件 */
  document?: TgFile
  /** GIF / 无声 MP4 */
  animation?: TgFile
  /** 音乐 */
  audio?: TgFile & { title?: string; performer?: string }
  /** 语音 */
  voice?: TgFile
  /** 视频 */
  video?: TgFile
  /** 圆形视频 */
  video_note?: TgFile
  /** 贴纸 */
  sticker?: TgSticker
  /** 位置 */
  location?: { latitude: number; longitude: number }
  /** 地点 */
  venue?: { location: { latitude: number; longitude: number }; title?: string; address?: string }
  /** 联系人名片 */
  contact?: { first_name?: string; last_name?: string; user_id?: number }
  /** 骰子 */
  dice?: { emoji: string; value: number }
  /** 投票 */
  poll?: { question?: string }
  /** 新成员 */
  new_chat_members?: TgUser[]
  /** 离开的成员 */
  left_chat_member?: TgUser
  /** 话题创建（服务消息） */
  forum_topic_created?: unknown
}

/** 按钮回调（`CallbackQuery`） */
export interface TgCallbackQuery {
  /** 回调 id，`answerCallbackQuery` 要用 */
  id: string
  /** 点击者 */
  from: TgUser
  /** 按钮所在的消息；过旧时为 `date === 0` 的 InaccessibleMessage */
  message?: TgMessage
  /** 内联模式消息的 id（本适配器不处理） */
  inline_message_id?: string
  /** 按钮的 callback_data */
  data?: string
}

/** 成员状态（`ChatMember`，只取用到的字段） */
export interface TgChatMember {
  /** creator / administrator / member / restricted / left / kicked */
  status: string
  /** 成员 */
  user: TgUser
  /** 管理员头衔 */
  custom_title?: string
  /** 禁言 / 封禁到期（秒级，0 为永久） */
  until_date?: number
}

/** 机器人自身的成员状态变化（`ChatMemberUpdated`） */
export interface TgChatMemberUpdated {
  /** 会话 */
  chat: TgChat
  /** 操作者 */
  from: TgUser
  /** 秒级时间戳 */
  date: number
  /** 变化前 */
  old_chat_member: TgChatMember
  /** 变化后 */
  new_chat_member: TgChatMember
}

/** 一个更新（`Update`） */
export interface TgUpdate {
  /** 递增序号 */
  update_id: number
  /** 新消息 */
  message?: TgMessage
  /** 按钮回调 */
  callback_query?: TgCallbackQuery
  /** 机器人自身的成员状态变化 */
  my_chat_member?: TgChatMemberUpdated
}

/** 群权限（`ChatPermissions`） */
export interface TgChatPermissions {
  /** 发文字 */
  can_send_messages?: boolean
  /** 发音频 */
  can_send_audios?: boolean
  /** 发文件 */
  can_send_documents?: boolean
  /** 发图片 */
  can_send_photos?: boolean
  /** 发视频 */
  can_send_videos?: boolean
  /** 发圆形视频 */
  can_send_video_notes?: boolean
  /** 发语音 */
  can_send_voice_notes?: boolean
  /** 发投票 */
  can_send_polls?: boolean
  /** 发贴纸、GIF、游戏 */
  can_send_other_messages?: boolean
  /** 链接预览 */
  can_add_web_page_previews?: boolean
  /** 改群信息 */
  can_change_info?: boolean
  /** 邀请成员 */
  can_invite_users?: boolean
  /** 置顶消息 */
  can_pin_messages?: boolean
  /** 管理话题 */
  can_manage_topics?: boolean
}

/** `getFile` 的返回 */
export interface TgFileInfo {
  /** 文件 id */
  file_id: string
  /** 下载路径；本地 Bot API 服务器（`--local`）下为本机绝对路径 */
  file_path?: string
  /** 字节数 */
  file_size?: number
}
