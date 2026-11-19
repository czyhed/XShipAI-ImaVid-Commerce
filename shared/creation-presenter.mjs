// 人物口播：前后端共用的模板、提示词与入参校验（不依赖 Node 内置模块）。
// 设计边界：只负责“把已知人物图 / 商品图 / 台词组装成一条参考模式视频节点”，
// 不负责生图、配音与视频提交；这些仍走既有画布节点、预览与运行体系。
import { VIDEO_RESOLUTIONS } from './creation-video-parameters.mjs';
import { SETTING_RATIOS } from './creation-video-settings.mjs';

export const PRESENTER_STYLES = ['handheld', 'tabletop', 'in-use'];
export const PRESENTER_STYLE_LABEL = { handheld: '手持展示', tabletop: '桌面展示', 'in-use': '使用中' };
export const PRESENTER_SOURCES = ['upload', 'generated'];
export const PRESENTER_DURATIONS = [5, 6, 7, 8, 9, 10];
export const PRESENTER_DEFAULT_DURATION = 8;
export const PRESENTER_MIN_DURATION = 5;
export const PRESENTER_MAX_DURATION = 10;
export const PRESENTER_MAX_PRODUCT_IMAGES = 3;
export const PRESENTER_DEFAULT_ROLE = '主播';
export const PRESENTER_DEFAULT_SPEAKER = 'zh_female_xiaohe_uranus_bigtts';
export const PRESENTER_DEFAULT_TITLE = '人物口播';
export const PRESENTER_IMAGE_DESCRIPTION = '一位 28 岁左右的亚洲女性，干净利落，米白色针织上衣，友善自信';
export const PRESENTER_DEFAULT_RATIOS = ['9:16', '16:9', '1:1'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const STYLE_ACTION = {
 handheld: '双手自然持握商品，把商品正面朝向镜头展示，商品放在胸前偏下，不要挡住脸',
 tabletop: '站在桌边，半身入镜，手掌自然指向桌上的商品，脸始终朝向镜头',
 'in-use': '正在自然地使用商品，同时转向镜头讲解，脸部保持完整可见',
};

// 口播台词按中文每秒约 4 字控制；这是服务端裁剪与界面计数共用的上限。
export const presenterDialogueLimit = duration => Math.max(1, Math.floor((Number.isFinite(Number(duration)) ? Number(duration) : PRESENTER_DEFAULT_DURATION) * 4));

// 去掉标签、emoji、换行与整句包裹的引号，再按当前时长截断。保留中文标点与内部空格。
export function sanitizePresenterLine(input, duration = PRESENTER_DEFAULT_DURATION) {
 let text = String(input ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
 text = text.replace(/^["'“”‘’「」『』]+/, '').replace(/["'“”‘’「」『』]+$/, '').trim();
 return [...text].slice(0, presenterDialogueLimit(duration)).join('').trim();
}

// 持物图（人物手里拿着商品）提示词选择：key 由前端下拉框提交，服务端按 key 取模板，不信任前端传来的整段文本。
// 输入图顺序固定：第 1 张是人物，其余是商品。
export const HOLD_PROMPT_OPTIONS = [
 { key: 'chest', label: '胸前手持（推荐）', text: '商品位于胸前偏下、下巴与腰之间，单手或双手自然托住，商品正面朝向镜头，商品完整可见、不被手指遮挡，商品离嘴与脸至少一个手掌的距离。' },
 { key: 'side', label: '单手侧举展示', text: '单手把商品举到身体一侧的胸口高度，商品正面朝向镜头，另一只手自然垂放；商品完整可见，不遮挡脸。' },
 { key: 'both', label: '双手捧持展示', text: '双手在胸前捧着商品，手指自然包住商品两侧而不覆盖主要图案，商品正面朝向镜头，位置在胸口以下。' },
 { key: 'custom', label: '自定义（只用下方补充说明）', text: '' },
];
export const HOLD_PROMPT_KEYS = HOLD_PROMPT_OPTIONS.map(option => option.key);
export function presenterHoldPrompt(key = 'chest', extra = '') {
 const option = HOLD_PROMPT_OPTIONS.find(item => item.key === key) || HOLD_PROMPT_OPTIONS[0];
 const note = String(extra ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
 return [
  '把第 2 张及之后的商品图中的商品，放进第 1 张图里这位人物的手中，生成一张电商口播用的静态定妆图。',
  '人物的脸、发型、服装、肤色必须与第 1 张图完全一致，不改变身份。',
  '构图：竖构图半身中景，不是特写，镜头与人物眼睛齐平，机位距人物约 1.5–2 米，人物不贴近镜头；人物从头顶到腰部约占画面高度的 80%，头顶上方留出约画面高度 10% 的空白，画面上下边缘都不贴住人物。',
  '整张脸从额头到下巴完整可见，位于画面上三分之一内，不被画面任何边缘裁切，也不被发丝、手指或商品遮挡；双肩、双手和手中的商品完整入镜；人物居中；纯色干净背景，柔和均匀的正面光，真实摄影质感。',
  option.text ? `持物方式：${option.text}` : '',
  '商品的形状、颜色、比例、包装与主要图案必须与商品图一致，不改变商品设计，不添加不存在的结构；每只手五根手指，手指数量与姿态自然，手与商品接触合理，没有穿模和多余肢体。',
  note ? `补充要求：${note}` : '',
  '画面中不要出现文字、水印、logo、价格或其他人物。',
 ].filter(Boolean).join('\n');
}

// 参考模式提示词：人物图与商品图都通过画布节点的 {{ref:节点编号}} 标签引用，
// 由服务端在提交时换算为 <Picture N>，因此这里不写死编号。
// 台词不写进提示词：口型同步时由服务端追加 <d>…</d> 与“音色参考 <Audio N>”，
// 后期配音时台词只用于 TTS，避免 H3 另外生成人声。
export function buildPresenterPrompt({ style = 'handheld', personTag, productTags = [], productName = '', holdTag = '' } = {}) {
 if (holdTag) {
  // 已有持物图：人物、手和商品都已在这张图里就位，视频只允许轻微动作 + 开口说话。
  return [
   `以 ${holdTag} 作为首帧和唯一依据：保持画面里的同一个人、同一套服装、同一只手和手中的同一件商品。`,
   '镜头固定不动：不推近、不拉远、不缩放、不摇移、不平移，首帧的整幅画面从头到尾完整保留，不放大、不裁切任何边缘内容。',
   '人物始终停留在画面中央，与镜头的距离不变，不向镜头走近，不变成特写；构图为半身中景，从头顶到腰部，人物约占画面高度的 80%，头顶上方始终留出空白。',
   '整张脸从额头到下巴全程完整在画面内，不被上下左右任何边缘裁切；双肩、双手和商品也全程完整入镜。',
   '只做自然的呼吸起伏、眨眼和很小幅度的头部自然晃动，正在自然地开口说话；脸始终正对镜头，不转头、不低头、不侧脸。',
   '手和手中的商品保持稳定，不挥手、不举起、不旋转、不换手；背景、光线和色调与首帧保持一致，真实电商短视频质感。',
   '画面中不出现价格、销量、认证、功效结论、品牌标语、水印或任何字幕文字；不要生成画面内文字。',
  ].join('\n');
 }
 const action = STYLE_ACTION[style] || STYLE_ACTION.handheld;
 const hasProduct = productTags.length > 0 || Boolean(productName);
 const person = personTag
  ? `人物外观严格参考 ${personTag}：保持同一张脸、发型与服装，不改变人物身份；脸部特征清晰可辨。`
  : '人物为一位真实感强的成年主播，面部与服装自然。';
 const products = productTags.length
  ? `商品外观严格参考 ${productTags.join('、')} 的形状、颜色、包装与主要结构，不改变商品设计；商品位于胸前或画面下三分之一，不遮挡面部。`
  : productName
   ? `商品是「${productName}」，外观保持真实，不添加不存在的结构；商品位于胸前或画面下三分之一，不遮挡面部。`
   : '画面中只有主播本人，不需要出现商品。';
 const subject = hasProduct
  ? '画面主体是主播本人，不是商品特写；商品只是手持道具，不能挡住脸、眼睛或嘴。'
  : '画面主体是主播本人，脸部完整可见，不要拍成商品特写。';
 return [
  '真人主播出镜口播，半身中景（从头顶上方到腰部），不是特写，镜头与人物眼睛齐平、机位距人物约 1.5–2 米；人物约占画面高度的 80%，头顶上方留出空白，整张脸从额头到下巴和双肩完整入镜、不被画面边缘裁切；脸部清晰、始终面向镜头，表情自然，正在开口说话；镜头稳定，光线柔和明亮，真实电商短视频质感。',
  subject,
  person,
  products,
  `动作：${action}。`,
  '不要拉远成全身远景，不要裁掉头顶、眼睛或下巴；人物从头到尾保持同一张脸和同一套服装。',
  '画面中不出现价格、销量、认证、功效结论、品牌标语、水印或任何字幕文字；不要生成画面内文字。',
 ].join('\n');
}

// AI 虚拟人物定妆照：只生成“人”，不生成商品，减少人物与商品结构互相污染。
export function presenterImagePrompt(description = '') {
 const text = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000) || PRESENTER_IMAGE_DESCRIPTION;
 return `电商短视频出镜主播定妆照：${text}。正面半身中景（从头顶上方到腰部），不是特写，机位距人物约 1.5–2 米，人物约占画面高度的 80%，头顶上方留出约画面高度 10% 的空白，整张脸从额头到下巴完整可见且不被边缘裁切，双肩完整入镜，双手自然抬到胸前、五指完整可见，面向镜头，自然微笑，姿态放松，纯浅灰背景，柔和均匀的棚拍光，真实摄影质感，皮肤与发丝细节清晰。画面中不要出现文字、水印、logo、商品或其他人。`;
}

// 校验并补全人物口播入参。productId 来自项目：关联商品时至少需要一张商品参考图。
export function checkPresenterInput(input = {}, { productId = null } = {}) {
 const personAssetId = typeof input?.personAssetId === 'string' ? input.personAssetId.trim() : '';
 const holdAssetId = typeof input?.holdAssetId === 'string' ? input.holdAssetId.trim() : '';
 if (holdAssetId && !UUID.test(holdAssetId)) return { error: '持物图编号无效。' };
 if (!holdAssetId && !UUID.test(personAssetId)) return { error: '请选择或生成一张人物图片。' };
 const personSource = PRESENTER_SOURCES.includes(input?.personSource) ? input.personSource : 'upload';
 const style = PRESENTER_STYLES.includes(input?.style) ? input.style : 'handheld';
 const duration = Number(input?.duration ?? PRESENTER_DEFAULT_DURATION);
 if (!Number.isInteger(duration) || duration < PRESENTER_MIN_DURATION || duration > PRESENTER_MAX_DURATION) {
  return { error: `人物口播时长需为 ${PRESENTER_MIN_DURATION}–${PRESENTER_MAX_DURATION} 的整数秒。` };
 }
 const rawIds = Array.isArray(input?.productAssetIds) ? input.productAssetIds : [];
 if (rawIds.some(id => typeof id !== 'string' || !UUID.test(id.trim()))) return { error: '商品参考图编号无效。' };
 const picked = [...new Set(rawIds.map(id => id.trim()))];
 if (picked.length > PRESENTER_MAX_PRODUCT_IMAGES) return { error: `商品参考图最多 ${PRESENTER_MAX_PRODUCT_IMAGES} 张。` };
 if (productId && !picked.length && !holdAssetId) return { error: '请至少选择一张商品参考图。' };
 // 有持物图时，商品已经在图里，不再另外传商品参考图，避免视频模型被两套参考互相拉扯。
 const productAssetIds = holdAssetId ? [] : picked;
 const dialogueText = sanitizePresenterLine(input?.dialogueText, duration);
 if (!dialogueText) return { error: '请填写人物要说的台词。' };
 const resolution = VIDEO_RESOLUTIONS.includes(input?.resolution) ? input.resolution : '768P';
 const ratio = SETTING_RATIOS.includes(input?.ratio) ? input.ratio : '9:16';
 const dubMode = input?.dubMode === 'post' ? 'post' : input?.dubMode === 'lipsync' ? 'lipsync' : 'lipsync';
 const title = (typeof input?.title === 'string' ? input.title.trim() : '').slice(0, 100) || PRESENTER_DEFAULT_TITLE;
 return { input: { personAssetId, holdAssetId, personSource, style, duration, productAssetIds, dialogueText, resolution, ratio, dubMode, title } };
}

// 文本模型：第一人称、只使用商品事实、按秒数控制字数。与第三人称旁白提示词分开。
export const PRESENTER_DIALOGUE_SYSTEM = [
 '你是电商短视频的人物口播撰稿人。',
 '根据商品事实与这一镜的要求，为每个分镜写一句主播面向镜头说的第一人称口语台词（可以用“我”“这款”），不要第三人称旁白。',
 '输出纯 JSON {"lines":[{"taskId":"...","text":"..."}]}，必须覆盖输入的每一个 taskId，每个 taskId 一条。',
 '每句 18–32 个汉字，按每秒约 4 个汉字控制，含标点不超过该镜时长×4 字。',
 '只能使用商品事实与镜头要求里已有的信息；缺失就留白，不得编造价格、认证、销量、功效、对比结论或品牌代言。',
 '不要出现「镜头」「分镜」「画面」「台词」「配音」「主播」等制作词，不要括号、时间码、emoji，不要用引号包裹整句。',
].join('');
