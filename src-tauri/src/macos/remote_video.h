#import <CoreVideo/CoreVideo.h>
#include <stdint.h>
int32_t pp_rc_video_encode_pixels(void *handle,CVPixelBufferRef pixels,bool key,uint8_t **output,size_t *length,bool *outKey,char *codec,size_t capacity);
