// Built separately against pinned FFmpeg + SVT-AV1 into one replaceable dylib.
// This file never captures the desktop, opens devices or creates subprocesses.
#include "av1_bridge.h"
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
#include <stdlib.h>
#include <string.h>
#define PP_EXPORT __attribute__((visibility("default")))
#define PP_AV1_MAX_BYTES (8 * 1024 * 1024)
typedef struct {
    AVCodecContext *context;
    AVFrame *frame;
    AVPacket *packet;
    struct SwsContext *scale;
    uint32_t w, h;
    unsigned pending;
    int64_t last_at;
} Session;
PP_EXPORT uint32_t pp_av1_abi(void) { return 1; }
PP_EXPORT void pp_av1_free(uint8_t *data) { free(data); }
PP_EXPORT void pp_av1_close(void *handle) {
    Session *s = handle;
    if (!s) return;
    // SVT expects EOS before deinitialization, including paused/reset sessions.
    // Drain only this encoder's bounded pending queue; nothing is transmitted.
    if (s->context && avcodec_is_open(s->context) && s->packet) {
        avcodec_send_frame(s->context, NULL);
        for (unsigned i = 0; i < 16 && avcodec_receive_packet(s->context, s->packet) >= 0; i++)
            av_packet_unref(s->packet);
    }
    avcodec_free_context(&s->context);
    av_frame_free(&s->frame);
    av_packet_free(&s->packet);
    sws_freeContext(s->scale);
    free(s);
}
PP_EXPORT int32_t pp_av1_open(uint32_t w, uint32_t h, uint32_t fps, uint32_t bitrate, void **output) {
    if (!output) return 1;
    *output = NULL;
    // Software remote video has an explicit 1080p/30 budget. Larger modes use
    // the existing VideoToolbox path instead of unbounded CPU/memory growth.
    if (w < 64 || h < 64 || w % 2 || h % 2 || w > 1920 || h > 1080 ||
        fps < 1 || fps > 30 || bitrate < 100000 || bitrate > 100000000) return 1;
    const AVCodec *codec = avcodec_find_encoder_by_name("libsvtav1");
    if (!codec) return 2;
    Session *s = calloc(1, sizeof(*s));
    if (!s) return 4;
    s->w = w; s->h = h; s->last_at = INT64_MIN;
    s->context = avcodec_alloc_context3(codec);
    s->frame = av_frame_alloc(); s->packet = av_packet_alloc();
    if (!s->context || !s->frame || !s->packet) goto failed;
    AVCodecContext *c = s->context;
    c->width = w; c->height = h; c->pix_fmt = AV_PIX_FMT_YUV420P;
    c->time_base = (AVRational){1, 1000}; c->framerate = (AVRational){fps, 1};
    c->bit_rate = bitrate;
    c->gop_size = fps * 2; c->max_b_frames = 0;
    c->flags |= AV_CODEC_FLAG_LOW_DELAY | AV_CODEC_FLAG_CLOSED_GOP;
    c->color_range = AVCOL_RANGE_MPEG;
    c->colorspace = AVCOL_SPC_BT709; c->color_primaries = AVCOL_PRI_BT709;
    c->color_trc = AVCOL_TRC_BT709;
    AVDictionary *options = NULL;
    av_dict_set(&options, "preset", "12", 0);
    av_dict_set(&options, "svtav1-params", "rc=2:pred-struct=1:rtc=1:lookahead=0:hierarchical-levels=0:enable-tf=0:lp=2", 0);
    int status = avcodec_open2(c, codec, &options);
    bool unused = av_dict_count(options) != 0;
    av_dict_free(&options);
    if (status < 0 || unused) goto failed;
    s->frame->width = w; s->frame->height = h; s->frame->format = c->pix_fmt;
    s->frame->color_range = c->color_range; s->frame->colorspace = c->colorspace;
    s->frame->color_primaries = c->color_primaries; s->frame->color_trc = c->color_trc;
    if (av_frame_get_buffer(s->frame, 32) < 0) goto failed;
    s->scale = sws_getContext(w, h, AV_PIX_FMT_RGBA, w, h, AV_PIX_FMT_YUV420P,
                              SWS_FAST_BILINEAR, NULL, NULL, NULL);
    if (!s->scale) goto failed;
    const int *coefficients = sws_getCoefficients(SWS_CS_ITU709);
    if (sws_setColorspaceDetails(s->scale, coefficients, 1, coefficients, 0, 0, 1 << 16, 1 << 16) < 0) goto failed;
    *output = s;
    return 0;
failed:
    pp_av1_close(s);
    return 4;
}
PP_EXPORT int32_t pp_av1_encode(void *handle, const uint8_t *rgba, size_t length,
                               bool key, int64_t at_ms, PPAv1Packet *output) {
    if (!output) return 1;
    memset(output, 0, sizeof(*output));
    Session *s = handle;
    if (!s || !rgba || length != (size_t)s->w * s->h * 4 || at_ms <= s->last_at) return 1;
    if (av_frame_make_writable(s->frame) < 0) return 4;
    const uint8_t *source[] = {rgba, NULL, NULL, NULL};
    int strides[] = {(int)s->w * 4, 0, 0, 0};
    if (sws_scale(s->scale, source, strides, 0, s->h, s->frame->data, s->frame->linesize) != (int)s->h) return 4;
    s->frame->pts = at_ms;
    s->frame->pict_type = key ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    if (avcodec_send_frame(s->context, s->frame) < 0) return 4;
    s->last_at = at_ms; s->pending++;
    int status = avcodec_receive_packet(s->context, s->packet);
    if (status == AVERROR(EAGAIN)) return s->pending <= 8 ? 10 : 5;
    if (status < 0) return 4;
    if (!s->packet->data || s->packet->size <= 0 || s->packet->size > PP_AV1_MAX_BYTES ||
        s->packet->pts == AV_NOPTS_VALUE) { av_packet_unref(s->packet); return 4; }
    output->data = malloc(s->packet->size);
    if (!output->data) { av_packet_unref(s->packet); return 4; }
    memcpy(output->data, s->packet->data, s->packet->size);
    output->length = s->packet->size; output->at_ms = s->packet->pts;
    output->key = (s->packet->flags & AV_PKT_FLAG_KEY) != 0;
    s->pending--; av_packet_unref(s->packet);
    return 0;
}
