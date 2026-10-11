#import <CoreMedia/CoreMedia.h>
// Copies owned RGBA into a BGRA sample at a host-clock timestamp. Caller releases.
CMSampleBufferRef pp_recording_sample(const uint8_t *rgba,size_t length,uint32_t width,uint32_t height,CMTime timestamp);
