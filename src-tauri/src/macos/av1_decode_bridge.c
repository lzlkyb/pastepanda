// Bounded native AV1 receive extension, using FFmpeg's dav1d wrapper.
#include "av1_bridge.h"
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <stdlib.h>
#include <string.h>
#define PP_EXPORT __attribute__((visibility("default")))
#define PP_PIXELS (1920 * 1080)
typedef struct {
    AVCodecContext *context;
    AVFrame *frame;
    AVPacket *packet;
    struct SwsContext *scale;
} Receive;
PP_EXPORT void pp_av1_decode_close(void *handle) {
    Receive *s = handle;
    if (!s) return;
    avcodec_free_context(&s->context);
    av_frame_free(&s->frame);
    av_packet_free(&s->packet);
    sws_freeContext(s->scale);
    free(s);
}
PP_EXPORT int32_t pp_av1_decode_open(void **output) {
    if (!output) return 1;
    *output = NULL;
    const AVCodec *codec = avcodec_find_decoder_by_name("libdav1d");
    if (!codec) return 2;
    Receive *s = calloc(1, sizeof(*s));
    if (!s) return 4;
    s->context = avcodec_alloc_context3(codec);
    s->frame = av_frame_alloc(); s->packet = av_packet_alloc();
    if (!s->context || !s->frame || !s->packet) goto failed;
    s->context->thread_count = 2;
    s->context->max_pixels = PP_PIXELS;
    s->context->flags |= AV_CODEC_FLAG_LOW_DELAY;
    s->context->pkt_timebase = (AVRational){1, 1000};
    if (avcodec_open2(s->context, codec, NULL) < 0) goto failed;
    *output = s;
    return 0;
failed:
    pp_av1_decode_close(s);
    return 4;
}
PP_EXPORT int32_t pp_av1_decode(void *handle, const uint8_t *data, size_t length,
                               int64_t at_ms, PPAv1Picture *output) {
    if (!output) return 1;
    memset(output, 0, sizeof(*output));
    Receive *s = handle;
    if (!s || !data || !length || length > 8 * 1024 * 1024) return 1;
    // av_new_packet supplies FFmpeg's required zero-filled input padding.
    if (av_new_packet(s->packet, (int)length) < 0) return 4;
    memcpy(s->packet->data, data, length);
    s->packet->pts = s->packet->dts = at_ms;
    int status = avcodec_send_packet(s->context, s->packet);
    av_packet_unref(s->packet);
    if (status < 0) return 4;
    status = avcodec_receive_frame(s->context, s->frame);
    if (status == AVERROR(EAGAIN)) return 10;
    if (status < 0) return 4;
    AVFrame *f = s->frame;
    if (f->width < 1 || f->height < 1 || f->width > 1920 || f->height > 1920 ||
        (int64_t)f->width * f->height > PP_PIXELS || f->pts == AV_NOPTS_VALUE) goto failed;
    size_t bytes = (size_t)f->width * f->height * 4;
    uint8_t *rgba = malloc(bytes);
    if (!rgba) goto failed;
    s->scale = sws_getCachedContext(s->scale, f->width, f->height, f->format,
        f->width, f->height, AV_PIX_FMT_RGBA, SWS_FAST_BILINEAR, NULL, NULL, NULL);
    if (!s->scale) { free(rgba); goto failed; }
    int colorspace = f->colorspace == AVCOL_SPC_BT709 ? SWS_CS_ITU709 :
        f->colorspace == AVCOL_SPC_BT2020_NCL ? SWS_CS_BT2020 : SWS_CS_ITU601;
    const int *coefficients = sws_getCoefficients(colorspace);
    if (sws_setColorspaceDetails(s->scale, coefficients, f->color_range == AVCOL_RANGE_JPEG,
        coefficients, 1, 0, 1 << 16, 1 << 16) < 0) { free(rgba); goto failed; }
    uint8_t *dest[] = {rgba, NULL, NULL, NULL};
    int strides[] = {f->width * 4, 0, 0, 0};
    if (sws_scale(s->scale, (const uint8_t * const *)f->data, f->linesize,
                  0, f->height, dest, strides) != f->height) { free(rgba); goto failed; }
    *output = (PPAv1Picture){rgba, bytes, f->pts, f->width, f->height};
    av_frame_unref(f);
    return 0;
failed:
    av_frame_unref(f);
    return 4;
}
