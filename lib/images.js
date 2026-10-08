/**
 * 图片落库：把磁盘上的截图变成模型真正能看到的图片块。
 *
 * DSH 里图片**必须**经 `ctx.attachments.saveImage()` 落库，再把返回的引用放进
 * `{ type: 'image', attachment }` 内容块；把 base64 塞进文本块模型是看不到图的。
 *
 * 另外这里内联了官方 `read_image` 的「路由能力门」：当前路由的模型必须显式声明支持
 * 图片输入，否则整段图片会以别的方式进上下文。该函数在上游包里未导出，故按
 * `dsh-tool-fs/lib/index.js:898-906` 逐字照抄。本机路由 `routercode/deepseek-flash`
 * 已在 profile 里声明 `input: [text, image]`，可通过。
 *
 * schema 书写规范（读上游编译器 `packages/core/tools/src/schema.ts` 得出，两处都用
 * **属性级** `required: true`，由编译器上提为对象的 `required` 数组；对象必须显式声明
 * `additionalProperties`；**根节点不允许**顶层 `required` 数组，写了会在 defineTool 抛错）。
 *
 * @module dsh-computer-use/images
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { AttachmentId, AttachmentError } from '@deepseek-ai/dsh-attachment';
/** 支持的图片类型（与 `attachments.imageLimits.mediaTypes` 一致）。 */
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/**
 * 供 `output.schema.properties.image` 复用的作者形态 schema。
 * 注意必填写在**属性上**，不是顶层 `required` 数组。
 */
export const IMAGE_VALUE_PROPERTIES = {
    attachmentId: { type: 'string', required: true, description: '附件库里的图片标识。' },
    mediaType: { type: 'string', required: true, enum: [...MEDIA_TYPES], description: '图片媒体类型。' },
    bytes: { type: 'integer', required: true, description: '图片字节数。' },
    width: { type: 'integer', required: true, description: '图片宽度（像素）。' },
    height: { type: 'integer', required: true, description: '图片高度（像素）。' },
    name: { type: 'string', description: '展示用文件名。' },
};
/** 把结构化图片元数据还原成内容块。`render` 是纯同步函数，所以只能做这种投影。 */
export function imageContentBlock(image) {
    const ref = {
        attachmentId: AttachmentId(image.attachmentId),
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
    };
    return { type: 'image', attachment: ref };
}
/** 按扩展名推断媒体类型。 */
function mediaTypeForPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png')
        return 'image/png';
    if (ext === '.webp')
        return 'image/webp';
    if (ext === '.gif')
        return 'image/gif';
    return 'image/jpeg';
}
/** 路由图片能力缓存：`provider|model` → 不能附图的原因（undefined = 可以附图）。 */
const routeCache = new Map();
/**
 * 内联自上游 `assertImageCapableRoute`：当前路由的模型必须声明支持图片输入。
 *
 * 结果按 `provider|model` 缓存：模型能力在一次会话里不会变，而截图类工具**每次**都要问一遍
 * 就成了一次额外的往返开销（每张图都要付）。
 *
 * @returns 不能附图的说明；`undefined` 表示可以附图。
 */
async function imageRouteProblem(ctx, exec) {
    const agent = exec.agent;
    const routed = agent?.session.requestHeader()?.config;
    const routedConfig = routed;
    const options = agent?.options;
    const provider = routedConfig?.provider ?? options?.provider;
    const model = routedConfig?.model ?? options?.model;
    const llm = ctx.get('llm');
    if (provider === undefined || model === undefined || llm === undefined) {
        return '当前模型路由无法解析，无法确认它是否接受图片输入';
    }
    const key = `${provider}|${model}`;
    if (routeCache.has(key))
        return routeCache.get(key);
    let problem;
    try {
        const active = await llm.resolveModelInfo(provider, model, exec.signal);
        problem =
            active.inputModalities === undefined || !active.inputModalities.includes('image')
                ? `当前模型 "${model}" 未声明支持图片输入`
                : undefined;
    }
    catch (error) {
        return `无法确认模型 "${model}" 的图片能力：${String(error)}`;
    }
    if (routeCache.size > 16)
        routeCache.clear();
    routeCache.set(key, problem);
    return problem;
}
/** 清掉路由能力缓存（插件卸载时调用）。 */
export function clearImageRouteCache() {
    routeCache.clear();
}
/**
 * 把磁盘上的图片文件落库，供模型查看。
 * @param ctx - 插件上下文（取 `attachments` 服务）。
 * @param exec - 工具执行上下文（取路由与取消信号）。
 * @param filePath - 图片绝对路径。
 * @returns 附着结果；不可附着时给出原因，而不是让整次调用失败。
 */
export async function attachImage(ctx, exec, filePath) {
    const attachments = ctx.get('attachments');
    if (attachments === undefined)
        return { kind: 'skipped', reason: '当前组合没有挂载附件服务' };
    const problem = await imageRouteProblem(ctx, exec);
    if (problem !== undefined)
        return { kind: 'skipped', reason: problem };
    let data;
    try {
        data = await fs.readFile(filePath);
    }
    catch (error) {
        return { kind: 'skipped', reason: `读取截图失败：${String(error)}` };
    }
    const mediaType = mediaTypeForPath(filePath);
    try {
        const ref = await attachments.saveImage({ data, mediaType, name: path.basename(filePath) });
        return {
            kind: 'attached',
            image: {
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                ...(ref.name === undefined ? {} : { name: ref.name }),
            },
        };
    }
    catch (error) {
        if (error instanceof AttachmentError) {
            if (error.code === 'IMAGE_DIMENSION_TOO_LARGE' || error.code === 'IMAGE_TOO_MANY_PIXELS' || error.code === 'IMAGE_TOO_LARGE') {
                return {
                    kind: 'skipped',
                    reason: `截图超出附件库上限（${error.code}）；请降低插件配置 maxImageSide 后重试`,
                };
            }
            return { kind: 'skipped', reason: `截图落库失败（${error.code}）：${error.message}` };
        }
        return { kind: 'skipped', reason: `截图落库失败：${String(error)}` };
    }
}
