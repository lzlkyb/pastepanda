#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
// ABI 1. The caller serializes all accesses to a session. Packets belong to the
// bridge until pp_av1_free; the library must outlive the session and packets.
typedef struct {
    uint8_t *data;
    size_t length;
    int64_t at_ms;
    bool key;
} PPAv1Packet;
uint32_t pp_av1_abi(void);
int32_t pp_av1_open(uint32_t w, uint32_t h, uint32_t fps, uint32_t bitrate, void **output);
int32_t pp_av1_encode(void *handle, const uint8_t *rgba, size_t length,
                      bool key, int64_t at_ms, PPAv1Packet *output);
void pp_av1_close(void *handle);
void pp_av1_free(uint8_t *data);

// Optional ABI-1 receive extension. Missing symbols leave WebCodecs/AVC intact.
// Only one complete OBU packet is accepted per call; status 10 means no picture.
// RGBA is packed with stride width*4 and must be released using pp_av1_free.
typedef struct {
    uint8_t *data;
    size_t length;
    int64_t at_ms;
    uint32_t width, height;
} PPAv1Picture;
int32_t pp_av1_decode_open(void **output);
int32_t pp_av1_decode(void *handle, const uint8_t *data, size_t length,
                       int64_t at_ms, PPAv1Picture *output);
void pp_av1_decode_close(void *handle);
