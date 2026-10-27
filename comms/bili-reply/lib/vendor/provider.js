/**
 * The official bilibili API provider: search/type video search, the view
 * metadata endpoint, and WBI-signed player subtitle retrieval, all over
 * plain HTTPS JSON. Anonymous by default; an optional cookie unlocks
 * login-gated subtitles. Every request refuses redirects, and the cookie is
 * only ever sent to the configured API host - never to subtitle CDN hosts.
 */
import { BilibiliError } from "./types.js";
import { wbiSign } from "./wbi.js";
/** Provider registry id for the official API implementation. */
export const BILIBILI_PROVIDER_ID = 'bilibili-official';
/** Default API base URL. */
export const BILIBILI_DEFAULT_BASE_URL = 'https://api.bilibili.com';
/** Default browser-identifying User-Agent header. */
export const BILIBILI_DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/** Default per-request cooperative timeout (ms). */
export const BILIBILI_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** How long resolved WBI keys are reused before re-fetching from the nav API. */
export const BILIBILI_WBI_KEY_TTL_MS = 12 * 60 * 60 * 1000;
/** The search endpoint hard ceiling on page size. */
export const BILIBILI_SEARCH_MAX_PAGE_SIZE = 50;
/** Default subtitle language preference tag. */
export const BILIBILI_DEFAULT_SUBTITLE_LANGUAGE = 'zh-CN';
/** Homepage URL whose Set-Cookie supplies the anonymous buvid3 bootstrap. */
export const BILIBILI_COOKIE_BOOTSTRAP_URL = 'https://www.bilibili.com/';
/**
 * The official provider. One instance per plugin; WBI keys are cached
 * per instance and refreshed when the cached pair exceeds its TTL.
 */
export class BilibiliOfficialProvider {
    id = BILIBILI_PROVIDER_ID;
    wbiKeyPair;
    anonymousCookies = new Map();
    options;
    /** local patch (星鸢专属) 2026-10-25: 上一次打到 API 主机的真实时间（毫秒），用于请求最小间隔。 */
    lastRequestAt;
    /** local patch (星鸢专属) 2026-10-25: 风控冷却截止时间（毫秒）。吃到 -412 后把节奏压慢，冷却期内的请求先等。 */
    riskUntil = 0;
    /** local patch (星鸢专属) 2026-10-25: 连续风控的档位（0..2），对应退避阶梯 1.2s / 3s / 8s。 */
    riskLevel = 0;
    constructor(options = {}) {
        this.options = options;
    }
    /**
     * local patch (星鸢专属) 2026-10-25: 所有 API 请求之间至少隔 minRequestGapMs（默认 350ms）。
     * 内置 bilibili_* 连发 3 个以上就容易吃 -412 web 风控，这里从源头把节奏压慢，
     * 省得每个调用方自己记得 sleep。用真实时钟，别用注入时钟（测试里注入的时钟是常量）。
     *
     * 2026-10-25 晚二次补丁：实测 350ms 压不住（连发 2 条就 banned），所以
     *   ① 重接口（/x/player/* —— 字幕轨和 frames 都走这里）间隔翻倍；
     *   ② 吃到 -412 后进入冷却（1.2s → 3s → 8s 阶梯），冷却期内的请求先等着；
     *   ③ 冷却过后成功一次就归零。
     */
    async throttle(path) {
        const base = this.options.minRequestGapMs ?? 350;
        const heavy = typeof path === 'string' && path.startsWith('/x/player/');
        const gap = heavy ? base * 2 : base;
        if (gap > 0 && this.lastRequestAt !== undefined) {
            const wait = gap - (Date.now() - this.lastRequestAt);
            if (wait > 0)
                await sleepMs(wait);
        }
        const cooldown = this.riskUntil - Date.now();
        if (cooldown > 0)
            await sleepMs(cooldown);
        this.lastRequestAt = Date.now();
    }
    /** local patch (星鸢专属) 2026-10-25: 记一次风控，返回这次要退避多久（毫秒）。 */
    noteRisk() {
        const ladder = [1200, 3000, 8000];
        const level = Math.min(this.riskLevel, ladder.length - 1);
        const wait = ladder[level];
        this.riskLevel = Math.min(level + 1, ladder.length - 1);
        this.riskUntil = Date.now() + wait;
        return wait;
    }
    /** local patch (星鸢专属) 2026-10-25: 冷却期过去又来了一次成功请求，退避档位归零。 */
    noteOk() {
        if (this.riskLevel !== 0 && Date.now() >= this.riskUntil) {
            this.riskLevel = 0;
            this.riskUntil = 0;
        }
    }
    /**
     * local patch (星鸢专属) 2026-10-25: 读接口吃到风控 / 连不上时按退避阶梯重试。
     * 以前只等 1.2 秒重试一次，实测扛不住连续 -412（B站这套 cookie 更容易被盯）。
     * 现在 1.2s → 3s → 8s，最多 4 次尝试；网络层失败（BILIBILI_REQUEST_FAILED）照样重试。
     * 调用方取消（signal.aborted）或硬错误（登录 / 找不到视频）立刻抛出，不做无意义重试。
     */
    async requestJsonRetrying(path, params, signal) {
        const delays = [1200, 3000, 8000];
        let last;
        for (let attempt = 0; attempt <= delays.length; attempt += 1) {
            try {
                return await this.requestJson(path, params, signal);
            }
            catch (error) {
                last = error;
                const retryable = error instanceof BilibiliError
                    && (error.code === 'BILIBILI_RISK_CONTROL' || error.code === 'BILIBILI_REQUEST_FAILED');
                if (!retryable || attempt === delays.length || signal?.aborted === true)
                    break;
                await sleepMs(delays[attempt]);
            }
        }
        throw last;
    }
    /** Always usable: anonymous access needs no credentials. */
    available() {
        return true;
    }
    /** Search videos; drops rows without a bvid (ad slots) and strips markup. */
    async search(request, signal) {
        await this.ensureAnonymousCookies(signal);
        const params = {
            search_type: 'video',
            keyword: request.keyword,
            page: request.page,
            page_size: request.pageSize,
        };
        if (request.order !== undefined)
            params.order = request.order;
        try {
            const data = await this.requestJson('/x/web-interface/search/type', params, signal);
            return mapSearchData(data, request.page, request.pageSize);
        }
        catch (error) {
            // B站会定向风控默认综合排序(totalrank),而 pubdate/dm 排序通常放行:
            // 仅当调用方未显式指定排序时,遇到风控自动降级为 pubdate 重试一次;
            // 显式指定排序(或降级后仍被风控)则原样抛出。
            if (request.order === undefined && error instanceof BilibiliError && error.code === 'BILIBILI_RISK_CONTROL') {
                const fallbackData = await this.requestJson('/x/web-interface/search/type', { ...params, order: 'pubdate' }, signal);
                return mapSearchData(fallbackData, request.page, request.pageSize);
            }
            throw error;
        }
    }
    /** Fetch one video full metadata. */
    async video(request, signal) {
        const data = await this.requestJsonRetrying('/x/web-interface/view', { bvid: request.bvid }, signal);
        return mapVideoData(data, request.bvid);
    }
    /** Fetch one video's direct mp4 URL (single-segment durl). */
    async playurl(request, signal) {
        const detail = await this.video(request, signal);
        const data = await this.requestJsonRetrying('/x/player/playurl', {
            bvid: request.bvid,
            cid: detail.cid,
            qn: request.qn ?? 64,
            fnval: 0,
            platform: 'html5',
            high_quality: 1,
        }, signal);
        return mapPlayUrlData(data, request.bvid, detail.cid);
    }
    /** Fetch player endpoint metadata (preview sprite) for one video page. */
    async playerInfo(request, signal) {
        const data = await this.playerData(request.bvid, request.cid, signal);
        const previewPic = previewPicOf(data);
        return previewPic === undefined ? {} : { previewPic };
    }
    /**
     * local patch (星鸢专属) 2026-10-25: 取 /x/player/videoshot 的预览帧雪碧图。
     * preview_pic 经常缺失（那时 bilibili_frames auto 会静默退成封面图），
     * 这个接口匿名就有、几乎每条视频都给一张 10x10 的真帧网格。
     */
    async videoshot(request, signal) {
        const data = await this.requestJsonRetrying('/x/player/videoshot', {
            bvid: request.bvid,
            cid: request.cid,
            index: 1,
        }, signal);
        return mapVideoshotData(data);
    }
    /** Fetch raw bytes from an image CDN (sprite/cover); no cookie leaves the API host. */
    async fetchBytes(url, signal) {
        const absolute = url.startsWith('//') ? 'https:' + url : url;
        const timeoutMs = this.options.requestTimeoutMs ?? BILIBILI_DEFAULT_REQUEST_TIMEOUT_MS;
        const signals = [];
        if (signal !== undefined)
            signals.push(signal);
        signals.push(AbortSignal.timeout(timeoutMs));
        let response;
        try {
            response = await fetch(absolute, { signal: AbortSignal.any(signals), redirect: 'manual', headers: {
                    'user-agent': this.options.userAgent ?? BILIBILI_DEFAULT_USER_AGENT,
                } });
        }
        catch (cause) {
            if (signal?.aborted === true)
                throw cause;
            throw new BilibiliError('bilibili image fetch failed: ' + String(cause), 'BILIBILI_REQUEST_FAILED', { cause });
        }
        if (response.status >= 300 && response.status < 400) {
            throw new BilibiliError('bilibili refused an image redirect (HTTP ' + String(response.status) + ')', 'BILIBILI_REDIRECT_REFUSED');
        }
        return new Uint8Array(await response.arrayBuffer());
    }
    /** WBI-signed player metadata for one video page (shared by subtitles and frames). */
    async playerData(bvid, cid, signal) {
        const pair = await this.resolveWbiKeys(signal);
        const signed = wbiSign({ bvid, cid }, pair.imgKey, pair.subKey, this.nowSec());
        try {
            return await this.requestJson('/x/player/wbi/v2', signed, signal);
        }
        catch (error) {
            // local patch (星鸢专属): 登录账号被 wbi 接口风控（-412 request was banned）时，
            // 退回不需要 wbi 签名的旧接口 /x/player/v2 —— 实测同一个 cookie 在旧接口上是通的。
            if (!(error instanceof BilibiliError) || error.code !== 'BILIBILI_RISK_CONTROL')
                throw error;
            return this.requestJson('/x/player/v2', { bvid, cid }, signal);
        }
    }
    /**
     * Fetch one video subtitle transcript: view for the default cid,
     * WBI-signed player for the track list, then the selected track JSON
     * from its CDN host.
     */
    async subtitles(request, signal) {
        const detail = await this.video(request, signal);
        const preferred = request.language ?? this.options.subtitleLanguage ?? BILIBILI_DEFAULT_SUBTITLE_LANGUAGE;
        const attempts = 3;
        const seen = { wrong: 0, empty: 0, blocked: 0 };
        let lastError;
        // local patch (星鸢专属) 2026-10-25: B站 AI 字幕接口会**按请求随机**串号——
        // 同一条视频，这一秒返回别人的字幕文件，下一秒（换条上游）又对了（实测 BV1XJn26BEa7）。
        // 所以：每个 round 把两条上游各试一次（wbi 接口 + 旧 /x/player/v2，缓存不同），
        // 一共 3 个 round，每条轨都过三道校验：
        //   ① player 数据里的 cid/aid/bvid 必须就是本条视频（数据层串号）；
        //   ② ai 字幕文件 URL 里 /prod/<全数字长串> 若存在，必须等于 <aid><cid>（文件层串号）；
        //   ③ cue 时长不能和视频时长对不上（内容层串号）。
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (attempt > 0)
                await sleepMs(attempt * 1000);
            for (const legacy of [false, true]) {
                try {
                    return await this.subtitlesVia(detail, preferred, legacy, signal);
                }
                catch (error) {
                    lastError = error;
                    const code = error instanceof BilibiliError ? error.code : undefined;
                    if (code === 'BILIBILI_SUBTITLES_UNAVAILABLE') {
                        if (/no accessible subtitle track/.test(String(error.message))) {
                            seen.empty += 1; // 两条上游都这么说才算真没字幕（见收尾判断）
                        }
                        else {
                            seen.wrong += 1; // 串号 / 空 URL / 时长对不上：换另一条上游，别等
                        }
                        continue;
                    }
                    if (code === 'BILIBILI_RISK_CONTROL' || code === 'BILIBILI_REQUEST_FAILED') {
                        seen.blocked += 1;
                        continue;
                    }
                    throw error; // 登录 / 找不到视频之类的硬错误，重试无意义
                }
            }
            // 两条上游都说「没有字幕轨」→ 就是没字幕，别再耗
            if (seen.empty >= 2 && seen.wrong === 0 && seen.blocked === 0)
                break;
        }
        const why = [];
        if (seen.wrong > 0)
            why.push('B站 returned a track that does not belong to this video ' + String(seen.wrong) + ' time(s)');
        if (seen.empty > 0)
            why.push('no subtitle file address ' + String(seen.empty) + ' time(s)');
        if (seen.blocked > 0)
            why.push('risk control refused ' + String(seen.blocked) + ' time(s)');
        const detailText = why.length > 0 ? ' (' + why.join('; ') + ')' : '';
        if (seen.wrong > 0) {
            // 把「串号」和「没字幕」分开报：调用方能判断是跳过、等一会、还是换工具。
            throw new BilibiliError('bilibili kept returning the wrong subtitle track for this video; the video may well have subtitles, they are just not reachable right now.'
                + detailText + '. Do not present any other track as this video\'s content; retry later or read the video with bilibili_frames / bilibili_video instead', 'BILIBILI_SUBTITLES_UNAVAILABLE');
        }
        throw lastError ?? new BilibiliError('no usable subtitle track after retries' + detailText, 'BILIBILI_SUBTITLES_UNAVAILABLE');
    }
    /**
     * local patch (星鸢专属) 2026-10-25: 取一次字幕并做全部校验（供 subtitles() 按上游重试）。
     * @param detail - the view metadata of the wanted video.
     * @param preferred - the preferred subtitle language tag.
     * @param legacy - true 走旧 /x/player/v2，false 走 wbi 签名接口。
     * @param signal - caller cancellation.
     * @returns the validated transcript.
     */
    async subtitlesVia(detail, preferred, legacy, signal) {
        const data = legacy
            ? await this.requestJson('/x/player/v2', { bvid: detail.bvid, cid: detail.cid }, signal)
            : await this.playerData(detail.bvid, detail.cid, signal);
        const identity = playerDataMismatch(data, detail);
        if (identity !== undefined) {
            throw new BilibiliError('bilibili returned player data belonging to another video: ' + identity, 'BILIBILI_SUBTITLES_UNAVAILABLE');
        }
        const allTracks = subtitleTracks(data);
        // 优先 AI 字幕轨：只有它的文件名带 prod/<aid><cid>，能精确验明正身；
        // UP 上传的 cc 字幕串号时没有任何可校验的标识。
        const aiTracks = allTracks.filter((track) => /^ai-/i.test(track.language));
        const tracks = aiTracks.length > 0 ? aiTracks : allTracks;
        const track = selectSubtitleTrack(tracks, preferred);
        if (/^ai-/i.test(track.language) && !subtitleUrlMatchesVideo(track.url, detail.aid, detail.cid)) {
            throw new BilibiliError('bilibili returned a subtitle track belonging to another video', 'BILIBILI_SUBTITLES_UNAVAILABLE');
        }
        const cues = await this.fetchSubtitleCues(track.url, signal);
        if (!transcriptMatchesDuration(cues, detail.duration)) {
            throw new BilibiliError('bilibili returned a subtitle track that does not match this video duration (' + String(Math.round(cues[cues.length - 1]?.to ?? 0)) + 's of ' + String(detail.duration) + 's)', 'BILIBILI_SUBTITLES_UNAVAILABLE');
        }
        return {
            bvid: detail.bvid,
            cid: detail.cid,
            language: track.language,
            trackCount: tracks.length,
            cues,
            transcript: cues.map(cue => cue.content).join('\n'),
        };
    }
    /**
     * One GET against the API host, returning the envelope data on code 0.
     * Refuses any redirect (credential-bearing requests must never follow one)
     * and rejects non-JSON bodies and non-zero business codes.
     */
    async requestJson(path, params, signal) {
        await this.throttle(path);
        const url = new URL(path, this.options.baseUrl ?? BILIBILI_DEFAULT_BASE_URL);
        for (const [key, value] of Object.entries(params))
            url.searchParams.set(key, String(value));
        const cookie = this.cookieHeader(this.options.cookie);
        const headers = {
            accept: 'application/json',
            'user-agent': this.options.userAgent ?? BILIBILI_DEFAULT_USER_AGENT,
            // local patch (星鸢专属): 带上 Referer，B站对无来源的 API 请求更容易返回空字幕/错字幕
            referer: 'https://www.bilibili.com/',
        };
        if (cookie !== undefined)
            headers.cookie = cookie;
        const timeoutMs = this.options.requestTimeoutMs ?? BILIBILI_DEFAULT_REQUEST_TIMEOUT_MS;
        const signals = [];
        if (signal !== undefined)
            signals.push(signal);
        signals.push(AbortSignal.timeout(timeoutMs));
        let response;
        try {
            response = await fetch(url, { signal: AbortSignal.any(signals), redirect: 'manual', headers });
        }
        catch (cause) {
            if (signal?.aborted === true)
                throw cause;
            throw new BilibiliError('bilibili network request failed (no HTTP response from ' + url.host + '; this is connectivity, not the -412 risk control): ' + String(cause), 'BILIBILI_REQUEST_FAILED', { cause });
        }
        this.captureCookies(response);
        if (response.status >= 300 && response.status < 400) {
            throw new BilibiliError('bilibili refused a redirect (HTTP ' + String(response.status) + ') from ' + url.host, 'BILIBILI_REDIRECT_REFUSED');
        }
        let body;
        try {
            body = await response.json();
        }
        catch (cause) {
            throw new BilibiliError('bilibili response was not JSON (HTTP ' + String(response.status) + ')', 'BILIBILI_BAD_RESPONSE', { cause });
        }
        const envelope = narrowEnvelope(body);
        if (envelope.code !== 0) {
            // local patch (星鸢专属) 2026-10-25: 吃到 -412 记一次风控，后面的请求自动退避。
            if (envelope.code === -412)
                this.noteRisk();
            throw businessError(envelope);
        }
        this.noteOk();
        return envelope.data;
    }
    /** Resolve the WBI key pair, reusing a fresh cached pair. */
    async resolveWbiKeys(signal) {
        const cached = this.wbiKeyPair;
        const now = this.now();
        if (cached !== undefined && now - cached.fetchedAt < BILIBILI_WBI_KEY_TTL_MS)
            return cached;
        const data = await this.requestJson('/x/web-interface/nav', {}, signal);
        const pair = wbiKeysFromData(data, this.now());
        this.wbiKeyPair = pair;
        return pair;
    }
    /**
     * Fetch one subtitle track JSON cue file from its CDN host. Deliberately
     * sends no cookie: the API credential is scoped to the API host only.
     */
    async fetchSubtitleCues(rawUrl, signal) {
        const url = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
        const timeoutMs = this.options.requestTimeoutMs ?? BILIBILI_DEFAULT_REQUEST_TIMEOUT_MS;
        const signals = [];
        if (signal !== undefined)
            signals.push(signal);
        signals.push(AbortSignal.timeout(timeoutMs));
        let response;
        try {
            response = await fetch(url, { signal: AbortSignal.any(signals), redirect: 'manual', headers: {
                    accept: 'application/json',
                    'user-agent': this.options.userAgent ?? BILIBILI_DEFAULT_USER_AGENT,
                } });
        }
        catch (cause) {
            if (signal?.aborted === true)
                throw cause;
            throw new BilibiliError('bilibili subtitle fetch failed: ' + String(cause), 'BILIBILI_REQUEST_FAILED', { cause });
        }
        if (response.status >= 300 && response.status < 400) {
            throw new BilibiliError('bilibili refused a subtitle redirect (HTTP ' + String(response.status) + ')', 'BILIBILI_REDIRECT_REFUSED');
        }
        let body;
        try {
            body = await response.json();
        }
        catch (cause) {
            throw new BilibiliError('bilibili subtitle response was not JSON (HTTP ' + String(response.status) + ')', 'BILIBILI_BAD_RESPONSE', { cause });
        }
        return parseSubtitleCues(body);
    }
    /**
     * Bootstrap the anonymous buvid3 cookie from the homepage once per
     * instance, before the risk-controlled search endpoint runs. A failed
     * bootstrap is deliberately swallowed: the search still proceeds and any
     * risk control surfaces as its own structured error.
     * @param signal - caller cancellation for the bootstrap request.
     */
    async ensureAnonymousCookies(signal) {
        if (this.anonymousCookies.size > 0)
            return;
        const timeoutMs = this.options.requestTimeoutMs ?? BILIBILI_DEFAULT_REQUEST_TIMEOUT_MS;
        const signals = [];
        if (signal !== undefined)
            signals.push(signal);
        signals.push(AbortSignal.timeout(timeoutMs));
        try {
            const response = await fetch(BILIBILI_COOKIE_BOOTSTRAP_URL, {
                signal: AbortSignal.any(signals),
                redirect: 'manual',
                headers: { 'user-agent': this.options.userAgent ?? BILIBILI_DEFAULT_USER_AGENT },
            });
            this.captureCookies(response);
        }
        catch {
            // Only the bootstrap fetch is swallowed: the homepage cookie is an
            // availability aid, never a precondition for search execution.
        }
    }
    /** Merge every Set-Cookie line of one response into the anonymous jar. */
    captureCookies(response) {
        for (const line of response.headers.getSetCookie()) {
            const match = /^([A-Za-z0-9_.-]+)=([^;]*)/.exec(line);
            if (match === null)
                continue;
            this.anonymousCookies.set(match[1] ?? '', match[2] ?? '');
        }
    }
    /**
     * One Cookie header joining the anonymous jar with the resolved user
     * credential; undefined when both are empty. A credential already carrying
     * an equals sign passes through as a full cookie header; a bare SESSDATA
     * token is wrapped with its cookie name.
     * @param userCookie - the optional resolved credential.
     * @returns the header value, when anything is present.
     */
    cookieHeader(userCookie) {
        const parts = [];
        for (const [name, value] of this.anonymousCookies)
            parts.push(name + "=" + value);
        if (userCookie !== undefined && userCookie.length > 0) {
            parts.push(userCookie.includes('=') ? userCookie : 'SESSDATA=' + userCookie);
        }
        return parts.length > 0 ? parts.join('; ') : undefined;
    }
    /** Epoch milliseconds from the injected clock or the real one. */
    now() {
        return this.options.now?.() ?? Date.now();
    }
    /** Unix seconds from the injected clock or the real one. */
    nowSec() {
        return Math.floor(this.now() / 1000);
    }
}
/**
 * Map a search/type data payload into one normalized result page.
 * @param data - the envelope data payload.
 * @param page - the requested page.
 * @param pageSize - the requested page size.
 * @returns rows, totals, and whether more pages follow.
 */
export function mapSearchData(data, page, pageSize) {
    const record = asRecord(data);
    const total = finiteNumber(record.numResults, 0);
    const rows = asRecordArray(record.result);
    const items = [];
    for (const row of rows) {
        const bvid = nonEmptyString(row.bvid);
        if (bvid === undefined)
            continue; // ad slots and pagination artifacts carry no bvid
        items.push({
            bvid,
            aid: finiteNumber(row.aid, 0),
            title: stripHighlight(row.title),
            description: nonEmptyString(row.description) ?? '',
            author: nonEmptyString(row.author) ?? '',
            authorMid: finiteNumber(row.mid, 0),
            play: finiteNumber(row.play, 0),
            danmaku: finiteNumber(row.danmaku, 0),
            favorite: finiteNumber(row.favorites, 0),
            comment: finiteNumber(row.video_review, 0),
            duration: nonEmptyString(row.duration) ?? '',
            publishAt: isoFromUnixSeconds(row.pubdate),
            coverUrl: urlOf(row.pic),
            url: videoUrl(bvid),
        });
    }
    return { items, page, pageSize, total, hasMore: page * pageSize < total };
}
/**
 * Map a view data payload into one normalized video detail.
 * @param data - the envelope data payload.
 * @param bvid - the requested bvid (echoed as the canonical identity).
 * @returns the normalized metadata.
 */
export function mapVideoData(data, bvid) {
    const record = asRecord(data);
    const owner = asRecord(record.owner);
    const stat = asRecord(record.stat);
    const pages = [];
    for (const row of asRecordArray(record.pages)) {
        pages.push({
            cid: finiteNumber(row.cid, 0),
            page: finiteNumber(row.page, 0),
            part: nonEmptyString(row.part) ?? '',
            duration: finiteNumber(row.duration, 0),
        });
    }
    const firstPage = pages[0];
    // B站会把 cid 放回 data.cid;个别响应里 pages[0].cid 可能缺失/为 0(如风控裁剪),
    // 此时必须回退到 data.cid,否则后续 playurl/subtitles/frames 全部带 0 请求失败。
    const firstCid = firstPage !== undefined && firstPage.cid > 0 ? firstPage.cid : finiteNumber(record.cid, 0);
    return {
        bvid,
        aid: finiteNumber(record.aid, 0),
        cid: firstCid,
        title: nonEmptyString(record.title) ?? '',
        description: nonEmptyString(record.desc) ?? '',
        author: nonEmptyString(owner.name) ?? '',
        authorMid: finiteNumber(owner.mid, 0),
        play: finiteNumber(stat.view, 0),
        danmaku: finiteNumber(stat.danmaku, 0),
        comment: finiteNumber(stat.reply, 0),
        favorite: finiteNumber(stat.favorite, 0),
        coin: finiteNumber(stat.coin, 0),
        share: finiteNumber(stat.share, 0),
        like: finiteNumber(stat.like, 0),
        duration: finiteNumber(record.duration, 0),
        publishAt: isoFromUnixSeconds(record.pubdate),
        coverUrl: urlOf(record.pic),
        url: videoUrl(bvid),
        typeName: nonEmptyString(record.tname) ?? '',
        pages,
    };
}
/**
 * Extract the track list from a player endpoint data payload.
 * @param data - the envelope data payload.
 * @returns the available tracks.
 * @throws BilibiliError BILIBILI_SUBTITLES_UNAVAILABLE for a missing or empty list.
 */
/** Map a playurl payload into the normalized direct-URL result. */
export function mapPlayUrlData(data, bvid, cid) {
    const record = asRecord(data);
    const durl = asRecordArray(record.durl);
    const first = durl[0];
    if (first === undefined) {
        throw new BilibiliError('this video exposes no playable mp4 url (login or higher-quality access may be required)', 'BILIBILI_PLAYURL_UNAVAILABLE');
    }
    const url = nonEmptyString(asRecord(first).url);
    if (url === undefined)
        throw new BilibiliError('the playurl payload carries no stream address', 'BILIBILI_PLAYURL_UNAVAILABLE');
    return {
        bvid,
        cid,
        url,
        quality: finiteNumber(record.quality, 0),
        size: finiteNumber(asRecord(first).size, 0),
    };
}
/** Extract the preview sprite URL from a player payload; undefined when absent. */
export function previewPicOf(data) {
    return nonEmptyString(asRecord(data).preview_pic);
}
export function subtitleTracks(data) {
    const record = asRecord(data);
    const subtitle = asRecord(record.subtitle);
    const rows = asRecordArray(subtitle.subtitles);
    const tracks = [];
    let dropped = 0;
    for (const row of rows) {
        const language = nonEmptyString(row.lan);
        const url = nonEmptyString(row.subtitle_url);
        // local patch (星鸢专属) 2026-10-25: 串号时 subtitle_url 常常是空串，
        // 以前会把空 URL 当成一条轨返回、后面在 fetch 里炸成 “Failed to parse URL”。
        // 这里直接丢掉，并在下面统一报「没有可用轨」。
        if (language === undefined || url === undefined) {
            dropped += 1;
            continue;
        }
        tracks.push({ language, languageDoc: nonEmptyString(row.lan_doc) ?? '', url });
    }
    if (tracks.length === 0) {
        throw new BilibiliError('this video exposes no accessible subtitle track (many tracks require a logged-in cookie)'
            + (dropped > 0 ? '; B站列了 ' + String(dropped) + ' 条轨但都没给字幕文件地址' : ''), 'BILIBILI_SUBTITLES_UNAVAILABLE');
    }
    return tracks;
}
/**
 * Select one track: an exact language match wins; otherwise the first.
 * @param tracks - the available tracks.
 * @param preferred - the preferred language tag.
 * @returns the selected track.
 */
export function selectSubtitleTrack(tracks, preferred) {
    const first = tracks[0];
    if (first === undefined)
        throw new BilibiliError('no subtitle track to select', 'BILIBILI_SUBTITLES_UNAVAILABLE');
    const exact = tracks.find(track => track.language === preferred);
    return exact ?? first;
}
/**
 * Parse a subtitle JSON body into validated cues (malformed rows dropped).
 * @param body - the track file parsed JSON.
 * @returns the cues in file order.
 * @throws BilibiliError BILIBILI_SUBTITLES_UNAVAILABLE for a body without cues.
 */
export function parseSubtitleCues(body) {
    const rows = asRecordArray(asRecord(body).body);
    const cues = [];
    for (const row of rows) {
        const content = nonEmptyString(row.content);
        if (content === undefined)
            continue;
        const from = numeric(row.from);
        const to = numeric(row.to);
        if (from === undefined || to === undefined)
            continue;
        cues.push({ from, to, content });
    }
    if (cues.length === 0) {
        throw new BilibiliError('the subtitle track body contains no usable cues', 'BILIBILI_SUBTITLES_UNAVAILABLE');
    }
    return cues;
}
/**
 * Local patch (星鸢专属): 字幕文件的 CDN 路径形如 /bfs/ai_subtitle/prod/<aid><cid><hash>，
 * 用它精确判断这条字幕是不是本视频的（B站串号时会给别家的 URL）。
 * 2026-10-25 修正：`ai-en` 这类轨的 URL 是 /prod/<32 位纯 hash>，没有 aid+cid 前缀，
 * 以前一刀切会把它误判成串号。现在只对「全数字长串」前缀做校验，纯 hash 直接放行（交给时长校验兜底）。
 */
function subtitleUrlMatchesVideo(url, aid, cid) {
    if (typeof url !== 'string' || url.length === 0)
        return false;
    const match = /\/prod\/(\d{12,})/.exec(url);
    if (match === null)
        return true;
    if (!(aid > 0) || !(cid > 0))
        return true;
    // 用 startsWith：「prod/<aid><cid><hash>」，hash 可能以数字开头，所以只校验前缀。
    return match[1].startsWith(String(aid) + String(cid));
}
/**
 * Local patch (星鸢专属) 2026-10-25: player 数据层串号的校验。
 * /x/player/(wbi/)v2 的数据里带本视频的 aid/bvid/cid，和 view 接口拿到的对不上就是串号。
 * 字段缺失（风控裁剪）时不判——只判明确给出的字段。
 * @param data - the player endpoint data payload.
 * @param detail - the view metadata this request asked for.
 * @returns a human-readable mismatch description, undefined when consistent.
 */
function playerDataMismatch(data, detail) {
    const record = asRecord(data);
    const cid = numeric(record.cid);
    if (cid !== undefined && cid > 0 && detail.cid > 0 && cid !== detail.cid)
        return 'cid ' + String(cid) + ' != ' + String(detail.cid);
    const aid = numeric(record.aid);
    if (aid !== undefined && aid > 0 && detail.aid > 0 && aid !== detail.aid)
        return 'aid ' + String(aid) + ' != ' + String(detail.aid);
    const bvid = nonEmptyString(record.bvid);
    if (bvid !== undefined && bvid.length > 0 && bvid !== detail.bvid)
        return 'bvid ' + bvid + ' != ' + detail.bvid;
    return undefined;
}
/** 简易 sleep：重试间隔用，避免再引入依赖。 */
function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Local patch (星鸢专属) 2026-10-25: 映射 /x/player/videoshot 的预览帧雪碧图数据。
 * B站绝大多数视频都有这个接口（匿名也能拿到），是 bilibili_frames auto 模式真正的帧来源；
 * preview_pic 缺失时以前会静默退到封面，等于"看不到画面"。
 * 数据形状：image 是每页一张雪碧图（10x10 或 5x5 网格），img_x_size/img_y_size 是单帧尺寸，
 * index 是每帧对应的时间戳（秒），indexs 同义（部分响应只有前者）。
 * @param data - the videoshot data payload.
 * @returns sprite pages plus the grid geometry; empty images when unavailable.
 */
export function mapVideoshotData(data) {
    const record = asRecord(data);
    const images = [];
    for (const item of Array.isArray(record.image) ? record.image : []) {
        const url = nonEmptyString(item);
        if (url !== undefined)
            images.push(url.startsWith('//') ? 'https:' + url : url);
    }
    const timestamps = [];
    const rawIndex = Array.isArray(record.index) ? record.index : Array.isArray(record.indexs) ? record.indexs : [];
    for (const item of rawIndex) {
        const seconds = numeric(item);
        if (seconds !== undefined)
            timestamps.push(seconds);
    }
    return {
        images,
        xLen: finiteNumber(record.img_x_len, 0),
        yLen: finiteNumber(record.img_y_len, 0),
        xSize: finiteNumber(record.img_x_size, 0),
        ySize: finiteNumber(record.img_y_size, 0),
        timestamps,
    };
}
/**
 * Local patch (星鸢专属): 判断一条字幕轨的结束时间是否可能属于这个视频。
 * B站 AI 字幕会随机串号，别人的字幕往往比本条视频长很多（也有更短的），
 * 用「最后一条 cue 的结束时间 ≤ 时长 + 10 秒」兜一层，明显对不上的直接重试。
 * @param cues - the parsed cues of one track.
 * @param duration - the video duration in seconds (0/unknown means "cannot judge").
 */
function transcriptMatchesDuration(cues, duration) {
    if (!Array.isArray(cues) || cues.length === 0)
        return false;
    if (!(typeof duration === 'number') || !(duration > 0))
        return true;
    const last = cues[cues.length - 1];
    const end = typeof last?.to === 'number' ? last.to : last?.from;
    if (typeof end !== 'number' || !Number.isFinite(end))
        return true;
    if (end > duration + 10)
        return false;
    // 串号过来的往往是别人的短视频：最后一条 cue 只覆盖开头一小段，也要拒掉。
    if (duration >= 30 && end < duration * 0.45)
        return false;
    return true;
}
/** Narrow an envelope, rejecting bodies missing the code field. */
function narrowEnvelope(body) {
    const record = asRecord(body);
    const code = numeric(record.code);
    if (code === undefined)
        throw new BilibiliError('bilibili response lacks a numeric code field', 'BILIBILI_BAD_RESPONSE');
    return { code, message: nonEmptyString(record.message) ?? '', data: record.data };
}
/** Map a non-zero envelope code into the structured error. */
function businessError(envelope) {
    const detail = envelope.message.length > 0 ? ': ' + envelope.message : '';
    switch (envelope.code) {
        case -412: return new BilibiliError('bilibili risk control rejected the request' + detail, 'BILIBILI_RISK_CONTROL', { bilibiliCode: envelope.code });
        case -403: return new BilibiliError('bilibili denied the request' + detail, 'BILIBILI_FORBIDDEN', { bilibiliCode: envelope.code });
        case -404: return new BilibiliError('bilibili could not find the video' + detail, 'BILIBILI_NOT_FOUND', { bilibiliCode: envelope.code });
        case -101: return new BilibiliError('bilibili requires a logged-in cookie for this data' + detail, 'BILIBILI_LOGIN_REQUIRED', { bilibiliCode: envelope.code });
        default: return new BilibiliError('bilibili API error ' + String(envelope.code) + detail, 'BILIBILI_API_ERROR', { bilibiliCode: envelope.code });
    }
}
/**
 * Extract the WBI key filename stems from a nav data payload.
 * @param data - the envelope data payload.
 * @param fetchedAt - epoch milliseconds this pair resolves at (the injected clock).
 * @returns the resolved pair stamped for TTL reuse.
 */
function wbiKeysFromData(data, fetchedAt) {
    const wbiImg = asRecord(asRecord(data).wbi_img);
    const imgUrl = nonEmptyString(wbiImg.img_url);
    const subUrl = nonEmptyString(wbiImg.sub_url);
    const imgKey = keyStem(imgUrl);
    const subKey = keyStem(subUrl);
    if (imgKey === undefined || subKey === undefined) {
        throw new BilibiliError('bilibili returned no usable WBI key material', 'BILIBILI_WBI_KEYS_UNAVAILABLE');
    }
    return { imgKey, subKey, fetchedAt };
}
/** The filename stem between the final slash and final dot, when present. */
function keyStem(url) {
    if (url === undefined)
        return undefined;
    const lastSlash = url.lastIndexOf('/');
    if (lastSlash === -1)
        return undefined;
    const base = url.slice(lastSlash + 1);
    const lastDot = base.lastIndexOf('.');
    const stem = lastDot === -1 ? base : base.slice(0, lastDot);
    return stem.length > 0 ? stem : undefined;
}
/** Wrap a record-like value; non-objects become an empty record. */
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
/** Wrap an array-like value; non-arrays become an empty array. */
function asRecordArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
}
/** A finite number, with the supplied fallback for absent or non-numeric values. */
function finiteNumber(value, fallback) {
    const parsed = numeric(value);
    return parsed === undefined ? fallback : parsed;
}
/** A finite numeric reading of the value, when the value is numeric. */
function numeric(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    return value;
}
/** A non-blank string reading of the value, when it is one. */
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** Strip bilibili keyword highlight markup from a search title. */
function stripHighlight(title) {
    const text = nonEmptyString(title) ?? '';
    return text.replace(/<[^>]*>/g, '');
}
/** Unix-seconds into an ISO-8601 string, empty when the value is invalid. */
function isoFromUnixSeconds(value) {
    const seconds = numeric(value);
    if (seconds === undefined || seconds <= 0)
        return '';
    return new Date(seconds * 1000).toISOString();
}
/** A http(s) URL reading, empty for anything else. */
function urlOf(value) {
    const text = nonEmptyString(value);
    if (text === undefined)
        return '';
    try {
        const parsed = new URL(text);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? text : '';
    }
    catch {
        return '';
    }
}
/** The canonical watch URL for a bvid. */
function videoUrl(bvid) {
    return 'https://www.bilibili.com/video/' + bvid;
}
//# sourceMappingURL=provider.js.map