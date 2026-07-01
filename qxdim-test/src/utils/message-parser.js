/**
 * 消息内容解析模块
 * 解析 Protobuf MessageContent 中各种类型的实际内容
 * 
 * 编码规则（逆向自 app.1778823952009.js）：
 * - searchableContent: 可搜索文本
 * - content: JSON 格式的结构化数据
 * - data (binaryContent): base64 编码的二进制数据
 * - mediaType: 媒体类型编号
 * - remoteMediaUrl: 远程媒体文件地址
 */

import { logger } from './logger.js';

// ==================== 内容类型编号 ====================

export const ContentType = {
  Unknown: 0,
  Text: 1,
  Voice: 2,
  Image: 3,
  Location: 4,
  File: 5,
  Video: 6,
  Sticker: 7,
  Link: 8,
  P_Text: 9,
  UserCard: 10,
  Composite_Message: 11,
  Rich_Notification: 12,
  Articles: 13,
  Streaming_Text_Generating: 14,
  Streaming_Text_Generated: 15,
  PttSoundData: 21,
  PttEnd: 22,
  PttSound: 23,
  PttStart: 24,
  Mark_Unread_Sync: 31,
  StartSecretChat_Notification: 40,
  Enter_Channel_Chat: 71,
  Leave_Channel_Chat: 72,
  Channel_Menu_Event: 73,
  RecallMessage_Notification: 80,
  DeleteMessage_Notification: 81,
  Tip_Notification: 90,
  Typing: 91,
  Friend_Greeting: 92,
  Friend_Added: 93,
  PC_Login_Request: 94,
  CreateGroup_Notification: 104,
  AddGroupMember_Notification: 105,
  KickOffGroupMember_Notification: 106,
  QuitGroup_Notification: 107,
  DismissGroup_Notification: 108,
  TransferGroupOwner_Notification: 109,
  ChangeGroupName_Notification: 110,
  ModifyGroupAlias_Notification: 111,
  ChangeGroupPortrait_Notification: 112,
  MuteGroup_Notification: 113,
  ChangeJoinType_Notification: 114,
  ChangePrivateChat_Notification: 115,
  ChangeSearchable_Notification: 116,
  SetGroupManager_Notification: 117,
  MuteGroupMember_Notification: 118,
  AllowGroupMember_Notification: 119,
  KickOffGroupMember_Visible_Notification: 120,
  QuitGroup_Visible_Notification: 121,
  ModifyGroupExtra_Notification: 122,
  ModifyGroupMemberExtra_Notification: 123,
  ModifyGroupSetting_Notification: 124,
  VOIP_CONTENT_TYPE_START: 400,
  VOIP_CONTENT_TYPE_ACCEPT: 401,
  VOIP_CONTENT_TYPE_END: 402,
  VOIP_CONTENT_TYPE_SIGNAL: 403,
  VOIP_CONTENT_TYPE_MODIFY: 404,
  VOIP_CONTENT_TYPE_ACCEPT_T: 405,
  VOIP_CONTENT_TYPE_ADD_PARTICIPANT: 406,
  VOIP_CONTENT_TYPE_MUTE_VIDEO: 407,
  CONFERENCE_CONTENT_TYPE_INVITE: 408,
  MESSAGE_CONTENT_TYPE_FEED: 501,
  MESSAGE_CONTENT_TYPE_COMMENT: 502,
  MESSAGE_CONTENT_TYPE_MIX_MULTI_MEDIA_TEXT: 510,
  MESSAGE_CONTENT_TYPE_MIX_FILE_TEXT: 511,
  MESSAGE_CONTENT_TYPE_CUSTOM_MESSAGE_TEST: 1001,
};

// ==================== 媒体类型编号 ====================

export const MediaType = {
  General: 0,
  Image: 1,
  Voice: 2,
  Video: 3,
  File: 4,
  Portrait: 5,
  Favorite: 6,
  Sticker: 7,
  Moments: 8,
};

// ==================== 持久化标志 ====================

export const PersistFlag = {
  No_Persist: 0,
  Persist: 1,
  Persist_And_Count: 3,
  Transparent: 4,
};

// ==================== 内容类型名称映射 ====================

const CONTENT_TYPE_NAMES = {
  [ContentType.Unknown]: '未知',
  [ContentType.Text]: '文本',
  [ContentType.Voice]: '语音',
  [ContentType.Image]: '图片',
  [ContentType.Location]: '位置',
  [ContentType.File]: '文件',
  [ContentType.Video]: '视频',
  [ContentType.Sticker]: '表情',
  [ContentType.Link]: '链接',
  [ContentType.P_Text]: '隐私文本',
  [ContentType.UserCard]: '名片',
  [ContentType.Composite_Message]: '合并消息',
  [ContentType.Rich_Notification]: '富文本通知',
  [ContentType.Articles]: '文章',
  [ContentType.Streaming_Text_Generating]: '流式文本(生成中)',
  [ContentType.Streaming_Text_Generated]: '流式文本(已生成)',
  [ContentType.RecallMessage_Notification]: '撤回消息',
  [ContentType.DeleteMessage_Notification]: '删除消息',
  [ContentType.Tip_Notification]: '提示通知',
  [ContentType.Typing]: '正在输入',
  [ContentType.Friend_Greeting]: '好友问候',
  [ContentType.Friend_Added]: '好友已添加',
  [ContentType.CreateGroup_Notification]: '创建群组',
  [ContentType.AddGroupMember_Notification]: '添加群成员',
  [ContentType.KickOffGroupMember_Notification]: '踢出群成员',
  [ContentType.QuitGroup_Notification]: '退出群组',
  [ContentType.DismissGroup_Notification]: '解散群组',
  [ContentType.VOIP_CONTENT_TYPE_START]: '通话开始',
  [ContentType.VOIP_CONTENT_TYPE_END]: '通话结束',
  [ContentType.MESSAGE_CONTENT_TYPE_FEED]: '朋友圈',
  [ContentType.MESSAGE_CONTENT_TYPE_COMMENT]: '评论',
  [ContentType.MESSAGE_CONTENT_TYPE_MIX_MULTI_MEDIA_TEXT]: '混合多媒体文本',
  [ContentType.MESSAGE_CONTENT_TYPE_MIX_FILE_TEXT]: '混合文件文本',
};

/**
 * 获取内容类型的友好名称
 * @param {number} type
 * @returns {string}
 */
export function getContentTypeName(type) {
  return CONTENT_TYPE_NAMES[type] || `未知类型(${type})`;
}

// ==================== 消息内容解析 ====================

/**
 * 解析 MessageContent 中的实际内容
 * 根据 content.type 字段分派到不同的解析逻辑
 * 
 * @param {object} content - Protobuf 解码后的 MessageContent 对象
 * @returns {object} 解析后的消息内容
 */
export function parseMessageContent(content) {
  if (!content) return null;

  const result = {
    type: content.type,
    typeName: getContentTypeName(content.type),
    raw: content,
  };

  try {
    switch (content.type) {
      case ContentType.Text:
        result.text = content.searchableContent || '';
        result.quoteInfo = parseBinaryContent(content.data, 'quote');
        break;

      case ContentType.P_Text:
        result.text = content.searchableContent || '';
        break;

      case ContentType.Image:
        result.thumbnail = content.data || '';
        result.dimensions = parseJSON(content.content);
        result.imageUrl = content.remoteMediaUrl || '';
        break;

      case ContentType.Voice:
        result.duration = parseJSON(content.content)?.duration;
        result.voiceUrl = content.remoteMediaUrl || '';
        break;

      case ContentType.Video:
        result.thumbnail = content.data || '';
        const videoMeta = parseJSON(content.content);
        result.duration = videoMeta?.d ?? videoMeta?.duration;
        result.videoUrl = content.remoteMediaUrl || '';
        break;

      case ContentType.File:
        result.fileName = content.searchableContent || '';
        result.fileSize = Number(content.content) || 0;
        result.fileUrl = content.remoteMediaUrl || '';
        break;

      case ContentType.Location:
        result.title = content.searchableContent || '';
        result.thumbnail = content.data || '';
        const locData = parseJSON(content.content);
        if (locData) {
          result.lat = locData.lat;
          result.long = locData.long;
        }
        break;

      case ContentType.Sticker:
        result.dimensions = parseBinaryContent(content.data, 'sticker');
        result.stickerUrl = content.remoteMediaUrl || '';
        break;

      case ContentType.Link:
        result.linkInfo = parseJSON(content.content);
        result.linkExtra = parseBinaryContent(content.data, 'json');
        break;

      case ContentType.UserCard:
        result.userInfo = parseBinaryContent(content.data, 'json');
        break;

      case ContentType.RecallMessage_Notification:
        result.recallData = parseBinaryContent(content.data, 'raw');
        break;

      case ContentType.Typing:
        result.typing = true;
        break;

      case ContentType.Tip_Notification:
        result.tip = content.searchableContent || content.content || '';
        break;

      case ContentType.Friend_Greeting:
      case ContentType.Friend_Added:
        result.notificationExtra = parseBinaryContent(content.data, 'json');
        break;

      case ContentType.VOIP_CONTENT_TYPE_START:
        result.voipData = parseJSON(content.content);
        result.pushContent = content.pushContent || '';
        result.pushData = parseJSON(content.pushData);
        break;

      default:
        // 通用解析：尝试解析所有文本字段
        result.textContent = content.searchableContent || content.content || '';
        result.binaryParsed = parseBinaryContent(content.data, 'auto');
        break;
    }
  } catch (e) {
    logger.warn(`[Content] 解析内容失败 (type=${content.type}):`, e.message);
  }

  return result;
}

/**
 * 安全解析 JSON 字符串
 * @param {string} str - JSON 字符串
 * @returns {object|null}
 */
function parseJSON(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * 解析 binaryContent (data 字段)
 * data 字段在传输时是 bytes，在 JS 中是 base64 字符串
 * 
 * @param {string|Uint8Array} data - 二进制数据
 * @param {string} hint - 解析提示 ('quote'|'sticker'|'json'|'raw'|'auto')
 * @returns {*}
 */
function parseBinaryContent(data, hint = 'auto') {
  if (!data) return null;

  try {
    let str;
    if (typeof data === 'string') {
      str = Buffer.from(data, 'base64').toString('utf8');
    } else if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      str = Buffer.from(data).toString('utf8');
    } else {
      return null;
    }

    if (!str || str.length === 0) return null;

    switch (hint) {
      case 'json': {
        const parsed = JSON.parse(str);
        return parsed;
      }
      case 'quote': {
        // 文本引用格式: {"quote":{...}}
        const parsed = JSON.parse(str);
        return parsed.quote || parsed;
      }
      case 'sticker': {
        // 表情尺寸格式: {"x":width,"y":height}
        const parsed = JSON.parse(str);
        return { width: parsed.x, height: parsed.y };
      }
      case 'raw':
        return str;
      case 'auto':
      default: {
        // 自动尝试 JSON 解析
        try {
          return JSON.parse(str);
        } catch {
          return str.substring(0, 200);
        }
      }
    }
  } catch (e) {
    return null;
  }
}

/**
 * 格式化消息内容为可读字符串
 * @param {object} parsedContent - parseMessageContent 的返回值
 * @returns {string}
 */
export function formatMessageContent(parsedContent) {
  if (!parsedContent) return '(空消息)';

  const lines = [`[${parsedContent.typeName}]`];

  if (parsedContent.text) lines.push(`  文本: ${parsedContent.text}`);
  if (parsedContent.imageUrl) lines.push(`  图片: ${parsedContent.imageUrl}`);
  if (parsedContent.voiceUrl) lines.push(`  语音: ${parsedContent.voiceUrl} (${parsedContent.duration}秒)`);
  if (parsedContent.videoUrl) lines.push(`  视频: ${parsedContent.videoUrl} (${parsedContent.duration}秒)`);
  if (parsedContent.fileName) lines.push(`  文件: ${parsedContent.fileName} (${formatFileSize(parsedContent.fileSize)})`);
  if (parsedContent.fileUrl) lines.push(`  文件URL: ${parsedContent.fileUrl}`);
  if (parsedContent.title) lines.push(`  位置: ${parsedContent.title}`);
  if (parsedContent.lat) lines.push(`  坐标: ${parsedContent.lat}, ${parsedContent.long}`);
  if (parsedContent.stickerUrl) lines.push(`  表情: ${parsedContent.stickerUrl}`);
  if (parsedContent.linkInfo) lines.push(`  链接: ${JSON.stringify(parsedContent.linkInfo)}`);
  if (parsedContent.userInfo) lines.push(`  名片: ${JSON.stringify(parsedContent.userInfo)}`);
  if (parsedContent.quoteInfo) lines.push(`  引用: ${JSON.stringify(parsedContent.quoteInfo)}`);
  if (parsedContent.typing) lines.push(`  正在输入...`);
  if (parsedContent.tip) lines.push(`  提示: ${parsedContent.tip}`);

  return lines.join('\n');
}

/**
 * 格式化文件大小
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}
