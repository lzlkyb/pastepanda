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
